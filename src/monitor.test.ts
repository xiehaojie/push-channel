import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testing as monitorTesting } from "./monitor.js";
import { setPushChannelRuntime } from "./runtime.js";
import { testing as subagentOrchestratorTesting } from "./subagent-orchestrator.js";

async function allocatePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (!address || typeof address === "string") {
    throw new Error("failed to allocate port");
  }
  return address.port;
}

async function waitForServer(url: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await fetch(url);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}

function startMonitorPushChannel(
  opts: Parameters<typeof import("./monitor.js").monitorPushChannel>[0],
): Promise<void> {
  return import("./monitor.js").then(({ monitorPushChannel }) => monitorPushChannel(opts));
}

describe("push-channel monitor", () => {
  afterEach(() => {
    subagentOrchestratorTesting.setSpawnMentionedSubagentImplForTest();
    vi.restoreAllMocks();
  });

  it("ensures session transcript file exists before dispatch", async () => {
    const port = await allocatePort();
    const abortController = new AbortController();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "push-channel-test-"));
    const storePath = path.join(tmpDir, "sessions.json");
    const sessionId = "test-session-uuid";
    const recordSessionMetaFromInbound = vi.fn(async () => ({
      sessionId,
      updatedAt: Date.now(),
    }));
    const dispatchReplyFromConfig = vi.fn(async () => ({ text: "ok" }));
    const withReplyDispatcher = vi.fn(async (params: { run: () => Promise<unknown> }) => {
      return await params.run();
    });
    setPushChannelRuntime({
      channel: {
        session: {
          resolveStorePath: vi.fn(() => storePath),
          recordSessionMetaFromInbound,
          recordInboundSession: vi.fn(async () => {}),
        },
        reply: {
          finalizeInboundContext: vi.fn((ctx) => ctx),
          withReplyDispatcher,
          dispatchReplyFromConfig,
        },
      },
      agent: {
        session: {
          resolveStorePath: vi.fn(() => storePath),
          resolveSessionFilePath: vi.fn(
            (sid: string) => path.join(tmpDir, `${sid}.jsonl`),
          ),
        },
      },
    } as unknown as PluginRuntime);

    const monitor = startMonitorPushChannel({
      config: {
        channels: {
          "push-channel": {
            enabled: true,
            middlewareUrl: "http://127.0.0.1:1",
            listenPort: port,
            listenPath: "/webhook",
          },
        },
      } as never,
      runtime: { log: vi.fn() } as never,
      accountId: "default",
      abortSignal: abortController.signal,
    });
    try {
      await waitForServer(`http://127.0.0.1:${port}/health`);

      const response = await fetch(`http://127.0.0.1:${port}/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: "main",
          sessionId: "demo-session",
          content: "hello",
        }),
      });
      await response.text();

      // Session metadata should be recorded before dispatch
      expect(recordSessionMetaFromInbound).toHaveBeenCalledTimes(1);
      expect(dispatchReplyFromConfig).toHaveBeenCalledTimes(1);

      // The transcript file should have been created (topic-suffixed)
      const transcriptPath = path.join(tmpDir, `${sessionId}-topic-demo-session.jsonl`);
      expect(fs.existsSync(transcriptPath)).toBe(true);
      const content = fs.readFileSync(transcriptPath, "utf-8");
      const header = JSON.parse(content.trim());
      expect(header.type).toBe("session");
      expect(header.id).toBe(sessionId);
      expect(header.version).toBe(3);
    } finally {
      abortController.abort();
      await monitor;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("spawns mentioned agents directly and returns their results to the main agent", async () => {
    const port = await allocatePort();
    const abortController = new AbortController();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "push-channel-mentions-test-"));
    const storePath = path.join(tmpDir, "sessions.json");
    let finalizedContext: Record<string, unknown> | null = null;
    const dispatchReplyFromConfig = vi.fn(async () => ({ text: "ok" }));
    const waitForRun = vi.fn(async () => ({ status: "ok" as const }));
    const getSessionMessages = vi.fn(async (params: { sessionKey: string }) => ({
      messages: [
        {
          id: `${params.sessionKey}:assistant`,
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: params.sessionKey.includes("researcher")
                  ? "Researcher found the background."
                  : "Coder produced the implementation notes.",
              },
            ],
          },
        },
      ],
    }));
    const spawnMentionedSubagent = vi
      .fn()
      .mockResolvedValueOnce({
        status: "accepted",
        runId: "run-researcher",
        childSessionKey: "agent:researcher:subagent:child-a",
      })
      .mockResolvedValueOnce({
        status: "accepted",
        runId: "run-coder",
        childSessionKey: "agent:coder:subagent:child-b",
      });
    subagentOrchestratorTesting.setSpawnMentionedSubagentImplForTest(spawnMentionedSubagent);
    setPushChannelRuntime({
      subagent: {
        run: vi.fn(),
        waitForRun,
        getSessionMessages,
        getSession: vi.fn(async () => ({ messages: [] })),
        deleteSession: vi.fn(async () => {}),
      },
      channel: {
        session: {
          resolveStorePath: vi.fn(() => storePath),
          recordSessionMetaFromInbound: vi.fn(async () => ({
            sessionId: "mention-session",
            updatedAt: Date.now(),
          })),
          recordInboundSession: vi.fn(async () => {}),
        },
        reply: {
          finalizeInboundContext: vi.fn((ctx) => {
            finalizedContext = ctx as Record<string, unknown>;
            return ctx;
          }),
          withReplyDispatcher: vi.fn(async (params: { run: () => Promise<unknown> }) => {
            return await params.run();
          }),
          dispatchReplyFromConfig,
        },
      },
      agent: {
        session: {
          resolveStorePath: vi.fn(() => storePath),
          resolveSessionFilePath: vi.fn(
            (sid: string) => path.join(tmpDir, `${sid}.jsonl`),
          ),
        },
      },
    } as unknown as PluginRuntime);

    const monitor = startMonitorPushChannel({
      config: {
        channels: {
          "push-channel": {
            enabled: true,
            middlewareUrl: "http://127.0.0.1:1",
            listenPort: port,
            listenPath: "/webhook",
          },
        },
      } as never,
      runtime: { log: vi.fn() } as never,
      accountId: "default",
      abortSignal: abortController.signal,
    });
    try {
      await waitForServer(`http://127.0.0.1:${port}/health`);

      const response = await fetch(`http://127.0.0.1:${port}/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: "main",
          sessionId: "demo-session",
          content: "please coordinate this",
          mentions: [
            { agentId: "researcher", label: "Researcher" },
            { agentId: "coder", label: "Coder" },
          ],
        }),
      });
      await response.text();

      expect(dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
      expect(spawnMentionedSubagent).toHaveBeenCalledTimes(2);
      expect(spawnMentionedSubagent).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          task: "please coordinate this",
          agentId: "researcher",
          label: "Researcher",
          parentSessionKey: "agent:main:channel:push-channel:direct:demo-session",
          requesterAgentId: "main",
        }),
      );
      expect(spawnMentionedSubagent).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          task: "please coordinate this",
          agentId: "coder",
          label: "Coder",
          parentSessionKey: "agent:main:channel:push-channel:direct:demo-session",
          requesterAgentId: "main",
        }),
      );
      expect(waitForRun).toHaveBeenCalledTimes(2);
      expect(waitForRun).toHaveBeenCalledWith({
        runId: "run-researcher",
        timeoutMs: monitorTesting.MENTION_SUBAGENT_WAIT_TIMEOUT_MS,
      });
      expect(waitForRun).toHaveBeenCalledWith({
        runId: "run-coder",
        timeoutMs: monitorTesting.MENTION_SUBAGENT_WAIT_TIMEOUT_MS,
      });
      expect(getSessionMessages).toHaveBeenCalledWith({
        sessionKey: "agent:researcher:subagent:child-a",
      });
      expect(getSessionMessages).toHaveBeenCalledWith({
        sessionKey: "agent:coder:subagent:child-b",
      });
      expect(finalizedContext).not.toBeNull();
      const bodyForAgent = String(finalizedContext?.["BodyForAgent"] ?? "");
      expect(bodyForAgent).toBe("please coordinate this");
      expect(finalizedContext?.["OriginatingTo"]).toBe("demo-session");
      expect(finalizedContext?.["WasMentioned"]).toBe(true);
      const dispatchedCtx = dispatchReplyFromConfig.mock.calls[0]?.[0]?.ctx as
        | Record<string, unknown>
        | undefined;
      const dispatchedBodyForAgent = String(dispatchedCtx?.["BodyForAgent"] ?? "");
      expect(dispatchedBodyForAgent).toContain("用户原始任务：\nplease coordinate this");
      expect(dispatchedBodyForAgent).toContain("## Researcher (@researcher)");
      expect(dispatchedBodyForAgent).toContain("Researcher found the background.");
      expect(dispatchedBodyForAgent).toContain("## Coder (@coder)");
      expect(dispatchedBodyForAgent).toContain("Coder produced the implementation notes.");
      expect(dispatchedCtx?.["WasMentioned"]).toBe(false);
    } finally {
      abortController.abort();
      await monitor;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not mark plain direct push messages as mentioned", async () => {
    const port = await allocatePort();
    const abortController = new AbortController();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "push-channel-direct-test-"));
    const storePath = path.join(tmpDir, "sessions.json");
    let finalizedContext: Record<string, unknown> | null = null;
    setPushChannelRuntime({
      channel: {
        session: {
          resolveStorePath: vi.fn(() => storePath),
          recordSessionMetaFromInbound: vi.fn(async () => ({
            sessionId: "direct-session",
            updatedAt: Date.now(),
          })),
          recordInboundSession: vi.fn(async () => {}),
        },
        reply: {
          finalizeInboundContext: vi.fn((ctx) => {
            finalizedContext = ctx as Record<string, unknown>;
            return ctx;
          }),
          withReplyDispatcher: vi.fn(async (params: { run: () => Promise<unknown> }) => {
            return await params.run();
          }),
          dispatchReplyFromConfig: vi.fn(async () => ({ text: "ok" })),
        },
      },
      agent: {
        session: {
          resolveStorePath: vi.fn(() => storePath),
          resolveSessionFilePath: vi.fn(
            (sid: string) => path.join(tmpDir, `${sid}.jsonl`),
          ),
        },
      },
    } as unknown as PluginRuntime);

    const monitor = startMonitorPushChannel({
      config: {
        channels: {
          "push-channel": {
            enabled: true,
            middlewareUrl: "http://127.0.0.1:1",
            listenPort: port,
            listenPath: "/webhook",
          },
        },
      } as never,
      runtime: { log: vi.fn() } as never,
      accountId: "default",
      abortSignal: abortController.signal,
    });
    try {
      await waitForServer(`http://127.0.0.1:${port}/health`);

      const response = await fetch(`http://127.0.0.1:${port}/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: "main",
          sessionId: "demo-session",
          content: "hello without mentions",
        }),
      });
      await response.text();

      expect(finalizedContext?.["WasMentioned"]).toBe(false);
    } finally {
      abortController.abort();
      await monitor;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});
