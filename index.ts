
import { randomUUID } from "node:crypto";
import {
  defineBundledChannelEntry,
} from "openclaw/plugin-sdk/channel-entry-contract";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import { getWriter, pushToolCallId, popToolCallId } from "./src/tool-store.js";

export default defineBundledChannelEntry({
    id: "push-channel",
    name: "Push Channel",
    description: "Custom push channel with middleware.",
    importMetaUrl: import.meta.url,
    plugin: {
        specifier: "./src/channel.js",
        exportName: "pushChannelPlugin",
    },
    runtime: {
        specifier: "./src/runtime.js",
        exportName: "setPushChannelRuntime",
    },
    registerFull(api: OpenClawPluginApi) {
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
        api.on("tool_result_persist", (event: Record<string, unknown>, ctx: { sessionKey?: string }) => {
            const sk = ctx.sessionKey;
            if (!sk) return;
            const writer = getWriter(sk);
            const toolCallId = popToolCallId(sk);
            if (!writer || !toolCallId) return;
            // event.message is AgentMessage containing the actual tool result content
            writer({ type: "tool_result", toolCallId, message: event["message"] });
        });
    },
});
