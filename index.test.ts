import { describe, expect, it, vi } from "vitest";
import { registerStreamingToolHooks } from "./index.js";
import { clearWriter, setWriter } from "./src/tool-store.js";

describe("push-channel subagent hook streaming", () => {
  it("emits subagent_start from the current subagent_spawned hook", async () => {
    const handlers = new Map<string, (event: Record<string, unknown>, ctx: Record<string, unknown>) => void>();
    const api = {
      on: vi.fn((name: string, handler: (event: Record<string, unknown>, ctx: Record<string, unknown>) => void) => {
        handlers.set(name, handler);
      }),
    };
    const events: Array<Record<string, unknown>> = [];
    const requesterSessionKey = "agent:main:channel:push-channel:direct:session-1";
    setWriter(requesterSessionKey, (event) => events.push(event));

    try {
      registerStreamingToolHooks(api as never);
      handlers.get("subagent_spawned")?.(
        {
          agentId: "researcher",
          label: "Researcher",
          childSessionKey: "agent:researcher:subagent:child",
        },
        {
          requesterSessionKey,
        },
      );

      expect(events).toEqual([
        {
          type: "subagent_start",
          agentId: "researcher",
          label: "Researcher",
          childSessionKey: "agent:researcher:subagent:child",
        },
      ]);
    } finally {
      clearWriter(requesterSessionKey);
    }
  });

  it("emits subagent_end with the spawned agent label", async () => {
    const handlers = new Map<string, (event: Record<string, unknown>, ctx: Record<string, unknown>) => void>();
    const api = {
      on: vi.fn((name: string, handler: (event: Record<string, unknown>, ctx: Record<string, unknown>) => void) => {
        handlers.set(name, handler);
      }),
    };
    const events: Array<Record<string, unknown>> = [];
    const requesterSessionKey = "agent:main:channel:push-channel:direct:session-2";
    const childSessionKey = "agent:researcher:subagent:child";
    setWriter(requesterSessionKey, (event) => events.push(event));

    try {
      registerStreamingToolHooks(api as never);
      handlers.get("subagent_spawned")?.(
        {
          agentId: "researcher",
          label: "Researcher",
          childSessionKey,
        },
        {
          requesterSessionKey,
        },
      );
      handlers.get("subagent_ended")?.(
        {
          targetSessionKey: childSessionKey,
          reason: "subagent-complete",
          outcome: "ok",
        },
        {
          requesterSessionKey,
        },
      );

      expect(events.at(-1)).toEqual({
        type: "subagent_end",
        agentId: "researcher",
        label: "Researcher",
        childSessionKey,
        status: "success",
      });
    } finally {
      clearWriter(requesterSessionKey);
    }
  });
});
