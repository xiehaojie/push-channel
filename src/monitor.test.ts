import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { monitorPushChannel } from "./monitor.js";
import { setPushChannelRuntime } from "./runtime.js";

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

describe("push-channel monitor", () => {
  afterEach(() => {
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

    const monitor = monitorPushChannel({
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
});
