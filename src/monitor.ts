import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import { keepHttpServerTaskAlive } from "openclaw/plugin-sdk/channel-lifecycle";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { resolveSessionTranscriptPathInDir } from "openclaw/plugin-sdk/session-store-runtime";
import { resolvePushChannelAccount } from "./config.js";
import {
  createPushChannelReplyDispatcher,
  createStreamingReplyDispatcher,
} from "./reply-dispatcher.js";
import { getPushChannelRuntime } from "./runtime.js";
import { rememberPushChannelSessionRoute } from "./session-routes.js";
import type { PushChannelMention, ResolvedPushChannelAccount } from "./types.js";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

type IncomingPushPayload = {
  agentId: string;
  sessionId: string;
  content: string;
  mentions?: PushChannelMention[];
};

/** Per-session dispatch mutex to prevent concurrent embedded agent runs on the same session. */
const sessionDispatchLocks = new Map<string, Promise<void>>();

const DEBUG_ENABLED = process.env.PUSH_CHANNEL_DEBUG === "1";

type FileFingerprint = {
  exists: boolean;
  size?: number;
  mtimeMs?: number;
  ino?: number;
};

function fingerprintFile(filePath: string): FileFingerprint {
  try {
    const st = fs.statSync(filePath);
    return { exists: true, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino };
  } catch {
    return { exists: false };
  }
}

function formatFingerprint(fp: FileFingerprint): string {
  if (!fp.exists) return "{exists:false}";
  return `{exists:true,size:${fp.size},mtimeMs:${fp.mtimeMs},ino:${fp.ino}}`;
}

function debugLog(log: (msg: string) => void, message: string): void {
  if (DEBUG_ENABLED) {
    log(`[PushChannel][DEBUG] ${message}`);
  }
}

function withSessionLock(sessionKey: string, fn: () => Promise<void>): Promise<void> {
  const prev = sessionDispatchLocks.get(sessionKey) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  sessionDispatchLocks.set(sessionKey, next);
  void next.finally(() => {
    if (sessionDispatchLocks.get(sessionKey) === next) {
      sessionDispatchLocks.delete(sessionKey);
    }
  });
  return next;
}

type MonitorPushChannelOptions = {
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  accountId: string;
  abortSignal: AbortSignal;
  setStatus?: (next: ChannelAccountSnapshot) => void;
};

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

function parseIncomingPayload(value: unknown): IncomingPushPayload | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const agentId = typeof record.agentId === "string" ? record.agentId.trim() : "";
  const rawSessionId = typeof record.sessionId === "string" ? record.sessionId.trim() : "";
  const content = typeof record.content === "string" ? record.content : "";
  const sessionId = rawSessionId || agentId;

  if (!agentId || !sessionId || !content) {
    return null;
  }
  return { agentId, sessionId, content, mentions: parseMentions(record.mentions) };
}

function parseMentions(value: unknown): PushChannelMention[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const mentions: PushChannelMention[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const agentId = typeof record.agentId === "string" ? record.agentId.trim() : "";
    if (!agentId || seen.has(agentId)) {
      continue;
    }
    seen.add(agentId);
    const label = typeof record.label === "string" ? record.label.trim() : "";
    mentions.push(label ? { agentId, label } : { agentId });
  }
  return mentions.length > 0 ? mentions : undefined;
}

function buildAgentFacingContent(payload: IncomingPushPayload): string {
  const mentions = payload.mentions ?? [];
  if (mentions.length === 0) {
    return payload.content;
  }
  const targets = mentions
    .map((mention) =>
      mention.label && mention.label !== mention.agentId
        ? `@${mention.agentId} (${mention.label})`
        : `@${mention.agentId}`,
    )
    .join(", ");
  return (
    `${payload.content}\n\n` +
    `[System: Required mentioned agents: ${targets}. ` +
    `The user explicitly mentioned these agents as strong constraints. ` +
    `You must delegate work to every listed agent and return their progress and final results to this same push-channel session.]`
  );
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

export async function monitorPushChannel(opts: MonitorPushChannelOptions): Promise<void> {
  const { config, runtime, accountId, abortSignal, setStatus } = opts;
  const log = (message: string) => runtime.log?.(message);
  const account = resolvePushChannelAccount(config, accountId);
  const port = account.config.listenPort;
  const path = account.config.listenPath;

  const server = http.createServer((req, res) => {
    void handleWebhookRequest({
      req,
      res,
      config,
      runtime,
      account,
      path,
    }).catch((error) => {
      log(`[PushChannel] Unhandled webhook error: ${formatError(error)}`);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("Internal Server Error");
      } else if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
        res.end();
      }
    });
  });

  server.on("error", (error) => {
    const errorMessage = formatError(error);
    log(`[PushChannel] Server error: ${errorMessage}`);
    setStatus?.({
      accountId,
      running: false,
      port,
      lastError: errorMessage,
    });
  });

  server.listen(port, () => {
    const message = `Push channel listening on port ${port}, path ${path}`;
    log(message);
    setStatus?.({
      accountId,
      running: true,
      connected: true,
      port,
      lastStartAt: Date.now(),
      lastError: null,
    });
  });

  await keepHttpServerTaskAlive({
    server,
    abortSignal,
    onAbort: async () => {
      log("Stopping Push Channel monitor");
      await closeServer(server);
      setStatus?.({
        accountId,
        running: false,
        connected: false,
        port,
        lastStopAt: Date.now(),
      });
    },
  });
}

async function handleWebhookRequest(params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  account: ResolvedPushChannelAccount;
  path: string;
}): Promise<void> {
  const { req, res, config, runtime, account, path } = params;
  const log = (message: string) => runtime.log?.(message);

  if (req.method !== "POST" || req.url !== path) {
    res.writeHead(404);
    res.end();
    return;
  }

  const body = await readRequestBody(req);

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    res.writeHead(400);
    res.end("Bad Request");
    return;
  }

  const payload = parseIncomingPayload(parsed);
  if (!payload) {
    res.writeHead(400);
    res.end("Missing agentId or content");
    return;
  }

  log(
    `[PushChannel] Webhook received message for sessionId: ${payload.sessionId}, agentId: ${payload.agentId}`,
  );

  try {
    await handleIncomingMessage(config, runtime, account, payload, res);
    if (!res.writableEnded) {
      if (!res.headersSent) {
        res.writeHead(200);
        res.end("OK");
      } else {
        res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
        res.end();
      }
    }
  } catch (error) {
    log(`[PushChannel] Error handling message: ${formatError(error)}`);
    if (!res.headersSent) {
      res.writeHead(500);
      res.end("Internal Server Error");
    } else if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
      res.end();
    }
  }
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/**
 * Ensure the session JSONL transcript file exists before the embedded agent
 * runner starts.  Without this the file is created mid-run by
 * SessionManager's first flush, which happens *after* the session-lock
 * fence fingerprint is captured ({exists:false}).  When the file later
 * appears the fence detects a false takeover and throws
 * EmbeddedAttemptSessionTakeoverError.
 *
 * This mirrors what `chat.send` does via `ensureTranscriptFile` in the
 * gateway – it writes a minimal session header so the file physically
 * exists before `releaseForPrompt()`.
 */
async function ensureSessionTranscriptFile(
  core: PluginRuntime,
  cfg: OpenClawConfig,
  sessionKey: string,
  agentId: string,
  topicId: string,
  ctx: Record<string, unknown>,
  log: (msg: string) => void,
): Promise<string | null> {
  const sessionModule = core.channel?.session;
  const agentsSession = core.agent?.session;
  if (!sessionModule || !agentsSession) {
    debugLog(log, `ensureSessionTranscriptFile: session modules unavailable (sessionKey=${sessionKey})`);
    return null;
  }

  // 1. Record session metadata so the store entry exists (await to completion).
  const storePath = agentsSession.resolveStorePath(cfg.session?.store, { agentId });
  const entry = await sessionModule.recordSessionMetaFromInbound({
    storePath,
    sessionKey,
    ctx,
    createIfMissing: true,
  });
  if (!entry?.sessionId) {
    debugLog(log, `ensureSessionTranscriptFile: recordSessionMetaFromInbound returned no sessionId`);
    return null;
  }

  // 2. Resolve the JSONL file path. When the entry already carries an explicit
  //    `sessionFile`, honour it; otherwise reconstruct the topic-suffixed
  //    filename the reply pipeline will use
  //    (`<sessionId>-topic-<MessageThreadId>.jsonl`, see
  //    src/auto-reply/reply/session.ts and src/config/sessions/paths.ts).
  //    Using `resolveSessionFilePath` without a topic would produce the wrong
  //    `<sessionId>.jsonl` path and trigger a false
  //    EmbeddedAttemptSessionTakeoverError when the real topic file appears
  //    mid-prompt.
  const sessionsDir = path.dirname(storePath);
  const transcriptPath = entry.sessionFile
    ? agentsSession.resolveSessionFilePath(
        entry.sessionId,
        { sessionFile: entry.sessionFile },
        { sessionsDir, agentId },
      )
    : resolveSessionTranscriptPathInDir(entry.sessionId, sessionsDir, topicId);
  if (!transcriptPath) {
    debugLog(log, `ensureSessionTranscriptFile: transcriptPath unresolved (sessionId=${entry.sessionId})`);
    return null;
  }

  const fpBefore = fingerprintFile(transcriptPath);
  debugLog(
    log,
    `ensureSessionTranscriptFile: pre  path=${transcriptPath} fingerprint=${formatFingerprint(fpBefore)}`,
  );

  // 3. Create the file with a session header if it does not exist. The
  //    version MUST match the current SessionManager schema version — if it
  //    doesn't, SessionManager._load() runs migrateToCurrentVersion() and
  //    invokes _rewriteFile() on first contact, which writes to the JSONL
  //    outside the embedded runner's fingerprint-tracked _processAgentEvent
  //    path. That trips the session-lock fence and throws
  //    EmbeddedAttemptSessionTakeoverError mid-prompt.
  if (!fs.existsSync(transcriptPath)) {
    log(`[PushChannel] Creating session transcript: ${path.basename(transcriptPath)}`);
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    const { CURRENT_SESSION_VERSION } = await import("openclaw/plugin-sdk/agent-sessions");
    const header = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: entry.sessionId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    };
    fs.writeFileSync(transcriptPath, `${JSON.stringify(header)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
  }

  const fpAfter = fingerprintFile(transcriptPath);
  debugLog(
    log,
    `ensureSessionTranscriptFile: post path=${transcriptPath} fingerprint=${formatFingerprint(fpAfter)}`,
  );
  return transcriptPath;
}

async function handleIncomingMessage(
  cfg: OpenClawConfig,
  runtime: RuntimeEnv,
  account: ResolvedPushChannelAccount,
  payload: IncomingPushPayload,
  res?: http.ServerResponse,
): Promise<void> {
  const core = getPushChannelRuntime();
  const log = (message: string) => runtime.log?.(message);
  const replyModule = core.channel?.reply;
  if (!replyModule) {
    throw new Error("Reply module not available in runtime.channel");
  }

  const channelId = "push-channel";
  const peerKind = "direct";
  const peerId = payload.sessionId;
  const sessionKey = `agent:${payload.agentId}:channel:${channelId}:${peerKind}:${peerId}`;
  rememberPushChannelSessionRoute({ sessionId: payload.sessionId, agentId: payload.agentId });
  const streaming = res ? createStreamingReplyDispatcher(res, sessionKey) : null;
  if (!streaming && !account.config.middlewareUrl) {
    throw new Error("[PushChannel] middlewareUrl not configured");
  }
  const dispatcher = streaming
    ? streaming.dispatcher
    : createPushChannelReplyDispatcher({
        middlewareUrl: account.config.middlewareUrl ?? "",
        agentId: payload.agentId,
        sessionId: payload.sessionId,
      });

  const agentFacingContent = buildAgentFacingContent(payload);
  const wasMentioned = (payload.mentions?.length ?? 0) > 0;
  const ctxPayload = replyModule.finalizeInboundContext({
    Body: payload.content,
    BodyForAgent: agentFacingContent,
    InboundHistory: undefined,
    ReplyToId: undefined,
    RootMessageId: undefined,
    RawBody: payload.content,
    CommandBody: agentFacingContent,
    From: payload.sessionId,
    To: payload.agentId,
    SessionKey: sessionKey,
    AgentId: payload.agentId,
    AccountId: account.accountId,
    ChatType: "direct",
    GroupSubject: undefined,
    SenderName: payload.sessionId,
    SenderId: payload.sessionId,
    Provider: channelId,
    Surface: channelId,
    MessageSid: Date.now().toString(),
    ReplyToBody: undefined,
    Timestamp: Date.now(),
    WasMentioned: wasMentioned,
    CommandAuthorized: true,
    OriginatingChannel: channelId,
    OriginatingTo: payload.sessionId,
    MessageThreadId: peerId,
  });

  await withSessionLock(sessionKey, async () => {
    debugLog(log, `handleIncomingMessage: lock acquired sessionKey=${sessionKey}`);
    // Ensure the session JSONL file exists before the embedded runner starts,
    // preventing false EmbeddedAttemptSessionTakeoverError from file creation
    // during model inference.
    const transcriptPath = await ensureSessionTranscriptFile(
      core,
      cfg,
      sessionKey,
      payload.agentId,
      peerId,
      ctxPayload,
      log,
    );

    const fpBeforeDispatch = transcriptPath ? fingerprintFile(transcriptPath) : null;
    if (transcriptPath) {
      debugLog(
        log,
        `handleIncomingMessage: pre-dispatch fingerprint=${formatFingerprint(fpBeforeDispatch!)} path=${transcriptPath}`,
      );
    }

    try {
      await replyModule.withReplyDispatcher({
        dispatcher,
        onSettled: () => {},
        run: () =>
          replyModule.dispatchReplyFromConfig({
            ctx: ctxPayload,
            cfg,
            dispatcher,
            replyOptions: {
              onModelSelected: () => {},
              disableBlockStreaming: !res,
              ...(streaming ? { onPartialReply: streaming.onPartialReply } : {}),
            },
          }),
      });
    } catch (error) {
      const errName = error instanceof Error ? error.constructor.name : typeof error;
      const fpAtError = transcriptPath ? fingerprintFile(transcriptPath) : null;
      log(
        `[PushChannel] dispatch failed sessionKey=${sessionKey} errorType=${errName} ` +
          `transcriptPath=${transcriptPath ?? "<unresolved>"} ` +
          `preFingerprint=${fpBeforeDispatch ? formatFingerprint(fpBeforeDispatch) : "n/a"} ` +
          `errorFingerprint=${fpAtError ? formatFingerprint(fpAtError) : "n/a"}\n` +
          `Stack:\n${formatError(error)}`,
      );
      throw error;
    }

    if (transcriptPath) {
      debugLog(
        log,
        `handleIncomingMessage: post-dispatch fingerprint=${formatFingerprint(fingerprintFile(transcriptPath))}`,
      );
    }
  });
}
