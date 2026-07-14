import { describe, expect, it, vi } from "vitest";
import { spawnMentionedSubagent } from "./subagent-orchestrator.js";
import { spawnSubagentDirect } from "../../../src/agents/subagent-spawn.js";

vi.mock("../../../src/agents/subagent-spawn.js", () => ({
  spawnSubagentDirect: vi.fn(async () => ({
    status: "accepted",
    runId: "run-1",
    childSessionKey: "agent:researcher:subagent:child",
  })),
}));

describe("push-channel mentioned subagent orchestration", () => {
  it("disables native completion wake so push-channel resumes the main agent after collecting results", async () => {
    await spawnMentionedSubagent({
      task: "please research this",
      agentId: "researcher",
      label: "Researcher",
      parentSessionKey: "agent:main:channel:push-channel:direct:session-1",
      channelId: "push-channel",
      accountId: "default",
      sessionId: "session-1",
      requesterAgentId: "main",
    });

    expect(spawnSubagentDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "please research this",
        agentId: "researcher",
        mode: "run",
        context: "isolated",
        expectsCompletionMessage: false,
      }),
      expect.objectContaining({
        agentSessionKey: "agent:main:channel:push-channel:direct:session-1",
        completionOwnerKey: "agent:main:channel:push-channel:direct:session-1",
        agentChannel: "push-channel",
        agentAccountId: "default",
        agentTo: "session-1",
        agentThreadId: "session-1",
        requesterAgentIdOverride: "main",
      }),
    );
  });
});
