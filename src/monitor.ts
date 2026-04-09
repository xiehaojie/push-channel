
import * as http from "node:http";
import type { RuntimeEnv, ClawdbotConfig } from "openclaw/plugin-sdk";
import { getPushChannelRuntime } from "./runtime.js";
import { createPushChannelReplyDispatcher, createStreamingReplyDispatcher } from "./reply-dispatcher.js";
import { checkAndMarkSeen } from "./dedup.js";
import { sendPushMessage } from "./send.js";
import type { ResolvedPushChannelAccount } from "./types.js";

// ---------------------------------------------------------------------------
// Account resolution
// ---------------------------------------------------------------------------

function resolveAccount(
  config: ClawdbotConfig,
  accountId: string,
): ResolvedPushChannelAccount {
  const root = (config.channels?.["push-channel"] as any) || {};
  const accountOverride =
    accountId !== "default" ? (root.accounts?.[accountId] ?? {}) : {};
  // Merge: account-level overrides win over root-level defaults
  const merged = { ...root, ...accountOverride, accounts: root.accounts };
  return {
    accountId,
    enabled: merged.enabled ?? false,
    configured: !!merged.middlewareUrl,
    name: merged.name ?? (accountId !== "default" ? accountId : "Push Channel"),
    config: merged,
  };
}

// ---------------------------------------------------------------------------
// Per-session sequential queue
//
// Concurrent messages for the SAME sessionKey caused two bugs:
//   1. The second request's call to `setWriter(sessionKey, writer)` inside
//      `createStreamingReplyDispatcher` overwrites the first request's writer.
//      When the first finishes, `clearWriter` removes the SECOND writer → the
//      second request loses its tool-event channel.
//   2. The core `withReplyDispatcher` may serialise by sessionKey internally,
//      so the second call throws/silently drops while the first holds the lock.
//
// Fix: we queue requests per sessionKey and run them one at a time.
// ---------------------------------------------------------------------------

const sessionQueues = new Map<string, Promise<void>>();

function enqueueForSession(sessionKey: string, task: () => Promise<void>): Promise<void> {
  const prev = sessionQueues.get(sessionKey) ?? Promise.resolve();
  const next = prev.then(task, task); // run regardless of previous outcome
  // Keep a weak reference; clean up once this is the latest and has settled
  next.finally(() => {
    if (sessionQueues.get(sessionKey) === next) {
      sessionQueues.delete(sessionKey);
    }
  });
  sessionQueues.set(sessionKey, next);
  return next;
}

// ---------------------------------------------------------------------------
// Typing indicator
// ---------------------------------------------------------------------------

async function sendTypingIndicator(
  middlewareUrl: string,
  agentId: string,
  sessionId: string | undefined,
  log: (msg: string) => void,
): Promise<void> {
  try {
    await sendPushMessage({
      middlewareUrl,
      agentId,
      sessionId,
      content: "__typing__", // sentinel the frontend can intercept
    });
  } catch (err) {
    // Non-fatal: typing indicator failure should never block processing
    log(`[PushChannel] typing indicator failed: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Main monitor entry point
// ---------------------------------------------------------------------------

export async function monitorPushChannel(opts: {
  config: ClawdbotConfig;
  runtime: RuntimeEnv;
  accountId: string;
  abortSignal: AbortSignal;
}): Promise<void> {
  const { config, runtime, accountId, abortSignal } = opts;
  const log = runtime.log ?? console.log;
  const account = resolveAccount(config, accountId);

  const port = account.config.listenPort || 3002;
  const path = account.config.listenPath || "/webhook";

  log(`[PushChannel][${accountId}] Starting on port ${port}, path ${path}`);

  const server = http.createServer((req, res) => {
    log(`[PushChannel][${accountId}] ${req.method} ${req.url}`);

    if (req.method === "POST" && req.url === path) {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        handleRequest(config, runtime, account, body, res, log).catch((err) => {
          log(`[PushChannel] Unhandled error in handleRequest: ${err}`);
          if (!res.headersSent) {
            res.writeHead(500);
            res.end("Internal Server Error");
          } else if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
            res.end();
          }
        });
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.on("error", (e: NodeJS.ErrnoException) => {
    const msg = `[PushChannel][${accountId}] Server error: ${e.code ?? e.message}`;
    console.error(msg);
    log(msg);
    if (e.code === "EADDRINUSE") {
      console.error(`[PushChannel] Port ${port} is already in use!`);
    }
  });

  // Properly resolve the promise when the server closes on abort.
  return new Promise<void>((resolve, reject) => {
    server.listen(port, () => {
      log(`[PushChannel][${accountId}] Listening on port ${port}, path ${path}`);
    });

    abortSignal.addEventListener("abort", () => {
      log(`[PushChannel][${accountId}] Stopping`);
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    server.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Per-request handler
// ---------------------------------------------------------------------------

async function handleRequest(
  config: ClawdbotConfig,
  runtime: RuntimeEnv,
  account: ResolvedPushChannelAccount,
  body: string,
  res: http.ServerResponse,
  log: (msg: string) => void,
): Promise<void> {
  // --- Parse ---
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(body);
  } catch {
    res.writeHead(400);
    res.end("Bad Request: invalid JSON");
    return;
  }

  const agentId = typeof data.agentId === "string" ? data.agentId.trim() : "";
  const rawSessionId = typeof data.sessionId === "string" ? data.sessionId.trim() : "";
  const content = typeof data.content === "string" ? data.content.trim() : "";
  const sessionId = rawSessionId || agentId;

  if (!agentId || !content) {
    res.writeHead(400);
    res.end("Missing agentId or content");
    return;
  }

  // --- Allowlist check ---
  const allowedSenders = account.config.allowedSenders;
  if (allowedSenders && allowedSenders.length > 0) {
    if (!allowedSenders.includes(agentId) && !allowedSenders.includes(sessionId)) {
      log(`[PushChannel] Rejected sender not in allowlist: agentId=${agentId}`);
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
  }

  // --- Dedup ---
  // Use a key that combines agentId + content hash (first 64 chars) + rough second bucket
  const dedupKey = `${agentId}:${content.slice(0, 64)}:${Math.floor(Date.now() / 3000)}`;
  if (checkAndMarkSeen(dedupKey)) {
    log(`[PushChannel] Deduplicated request for agentId=${agentId}`);
    res.writeHead(200);
    res.end("OK (deduplicated)");
    return;
  }

  log(`[PushChannel] Queuing message for agentId=${agentId}, sessionId=${sessionId}`);

  const channelId = "push-channel";
  const peerKind = "direct";
  const sessionKey = `agent:${agentId}:channel:${channelId}:${peerKind}:${sessionId}`;

  // --- Enqueue: ensure serial processing per session ---
  await enqueueForSession(sessionKey, async () => {
    // Typing indicator — send before the AI starts, non-blocking
    const typingEnabled = account.config.typingEnabled !== false; // default true
    if (typingEnabled && account.config.middlewareUrl) {
      void sendTypingIndicator(account.config.middlewareUrl, agentId, sessionId, log);
    }

    await handleIncomingMessage(
      config,
      runtime,
      account,
      sessionId,
      content,
      agentId,
      res,
      log,
    );
  });

  // Ensure response is finalised (defensive, normally done inside handleIncomingMessage)
  if (!res.writableEnded) {
    if (!res.headersSent) {
      res.writeHead(200);
    }
    res.end();
  }
}

// ---------------------------------------------------------------------------
// Core dispatch
// ---------------------------------------------------------------------------

async function handleIncomingMessage(
  cfg: ClawdbotConfig,
  runtime: RuntimeEnv,
  account: ResolvedPushChannelAccount,
  sessionId: string,
  content: string,
  agentId: string,
  res: http.ServerResponse,
  log: (msg: string) => void,
): Promise<void> {
  const core = getPushChannelRuntime();
  if (!core?.channel) {
    throw new Error("[PushChannel] runtime.channel not available");
  }
  const replyModule = core.channel.reply;
  if (!replyModule) {
    throw new Error("[PushChannel] runtime.channel.reply not available");
  }

  const channelId = "push-channel";
  const peerKind = "direct";
  const peerId = sessionId;
  const sessionKey = `agent:${agentId}:channel:${channelId}:${peerKind}:${peerId}`;

  const streaming = res ? createStreamingReplyDispatcher(res, sessionKey) : null;
  const dispatcher = streaming
    ? streaming.dispatcher
    : createPushChannelReplyDispatcher({
        middlewareUrl: account.config.middlewareUrl,
        agentId,
        sessionId,
      });

  const ctxPayload = replyModule.finalizeInboundContext({
    Body: content,
    BodyForAgent: content,
    InboundHistory: undefined,
    ReplyToId: undefined,
    RootMessageId: undefined,
    RawBody: content,
    CommandBody: content,
    From: sessionId,
    To: "bot",
    SessionKey: sessionKey,
    AgentId: agentId,
    AccountId: account.accountId,
    ChatType: "direct",
    GroupSubject: undefined,
    SenderName: sessionId,
    SenderId: sessionId,
    Provider: "push-channel",
    Surface: "push-channel",
    MessageSid: `${agentId}-${Date.now()}`,
    ReplyToBody: undefined,
    Timestamp: Date.now(),
    WasMentioned: true,
    CommandAuthorized: true,
    OriginatingChannel: "push-channel",
    OriginatingTo: peerId,
  });

  // Record inbound session so spawned sessions route back to push-channel
  if (core.channel.session) {
    try {
      const storePath = core.channel.session.resolveStorePath(undefined, { agentId });
      await core.channel.session.recordInboundSession({
        storePath,
        sessionKey,
        ctx: ctxPayload as any,
        createIfMissing: true,
        updateLastRoute: {
          sessionKey: `agent:${agentId}:main`,
          channel: "push-channel",
          to: peerId,
          accountId: account.accountId,
        },
        onRecordError: (err) => log(`[PushChannel] Failed to record inbound session: ${err}`),
      });
    } catch (err) {
      log(`[PushChannel] Error recording inbound session: ${err}`);
    }
  }

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
}

