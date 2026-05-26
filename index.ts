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
    const message = event.message as
      | { content?: unknown; isError?: boolean; details?: unknown }
      | undefined;
    const payload: Record<string, unknown> = { type: "tool_result", toolCallId };
    if (message?.content !== undefined) payload.content = message.content;
    if (message?.isError !== undefined) payload.isError = message.isError;
    if (event.toolName) payload.toolName = event.toolName;
    writer(payload);
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
