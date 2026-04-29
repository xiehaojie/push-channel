
import { randomUUID } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { pushChannelPlugin } from "./src/channel.js";
import { setPushChannelRuntime } from "./src/runtime.js";
import { getWriter, pushToolCallId, popToolCallId } from "./src/tool-store.js";
import { queryKnowledgeBase } from "./src/knowledge.js";

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
        api.on("tool_result_persist", (event: Record<string, unknown>, ctx: { sessionKey?: string }) => {
            const sk = ctx.sessionKey;
            if (!sk) return;
            const writer = getWriter(sk);
            const toolCallId = popToolCallId(sk);
            if (!writer || !toolCallId) return;
            writer({ type: "tool_result", toolCallId, message: event["message"] });
        });

        // Knowledge base retrieval: inject KB results into system context on every message.
        api.on("before_prompt_build", async (event) => {
          const kbConfig = (api.pluginConfig as any)?.knowledgeBase;
          if (!kbConfig?.enabled || !kbConfig?.apiEndpoint || !kbConfig?.datasetId) return {};

          const results = await queryKnowledgeBase(event.prompt, kbConfig);
          if (!results) return {};

          return {
            appendSystemContext:
              `<knowledge_base>\n${results}\n</knowledge_base>\n\n` +
              `Treat the above knowledge base results as supplemental context. ` +
              `Use them only if relevant to the user's latest message. ` +
              `Ignore if irrelevant or stale.`,
          };
        });
    },
};
