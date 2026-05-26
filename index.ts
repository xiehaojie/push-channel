import { randomUUID } from "node:crypto";
import {
  defineBundledChannelEntry,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/channel-entry-contract";
import { getWriter, pushToolCallId, popToolCallId } from "./src/tool-store.js";

function registerStreamingToolHooks(api: Pick<OpenClawPluginApi, "on">): void {
  api.on("before_tool_call", (event, ctx) => {
    const sessionKey = ctx.sessionKey;
    if (!sessionKey) {
      return;
    }
    const writer = getWriter(sessionKey);
    if (!writer) {
      return;
    }

    const toolCallId = event.toolCallId ?? ctx.toolCallId ?? `tool-${randomUUID()}`;
    writer({
      type: "tool_call",
      toolCallId,
      toolName: event.toolName,
      args: event.params,
    });
    pushToolCallId(sessionKey, toolCallId);
  });

  api.on("tool_result_persist", (event, ctx) => {
    const sessionKey = ctx.sessionKey;
    if (!sessionKey) {
      return;
    }
    const writer = getWriter(sessionKey);
    const pendingToolCallId = popToolCallId(sessionKey);
    const toolCallId = event.toolCallId ?? ctx.toolCallId ?? pendingToolCallId;
    if (!writer || !toolCallId) {
      return;
    }
    writer({ type: "tool_result", toolCallId });
  });
}

export default defineBundledChannelEntry({
  id: "push-channel",
  name: "Push Channel",
  description: "Push channel plugin for OpenClaw",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./src/channel.js",
    exportName: "pushChannelPlugin",
  },
  runtime: {
    specifier: "./src/runtime.js",
    exportName: "setPushChannelRuntime",
  },
  registerFull: registerStreamingToolHooks,
});
