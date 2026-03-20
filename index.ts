
import { randomUUID } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { pushChannelPlugin } from "./src/channel.js";
import { setPushChannelRuntime } from "./src/runtime.js";
import { getWriter, pushToolCallId, popToolCallId } from "./src/tool-store.js";

export default {
    id: "push-channel",
    name: "Push Channel",
    register(api: OpenClawPluginApi) {
        setPushChannelRuntime(api.runtime);
        api.registerChannel({ plugin: pushChannelPlugin });

        // Emit tool_call event when a tool is about to execute.
        api.on("before_tool_call", (event: { toolName: string; params?: Record<string, unknown> }, ctx: { sessionKey?: string }) => {
            const sk = ctx.sessionKey;
            if (!sk) return;
            const writer = getWriter(sk);
            if (!writer) return;
            const toolCallId = `tool-${randomUUID()}`;
            writer({
                type: "tool_call",
                toolCallId,
                toolName: event.toolName,
                args: event.params ?? {},
            });
            pushToolCallId(sk, toolCallId);
        });

        // Emit tool_result event when the tool result is persisted.
        api.on("tool_result_persist", (_event: Record<string, unknown>, ctx: { sessionKey?: string }) => {
            const sk = ctx.sessionKey;
            if (!sk) return;
            const writer = getWriter(sk);
            const toolCallId = popToolCallId(sk);
            if (!writer || !toolCallId) return;
            writer({ type: "tool_result", toolCallId });
        });
    }
};
