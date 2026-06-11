import { randomUUID } from "node:crypto";
import {
  defineBundledChannelEntry,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/channel-entry-contract";
import { getWriter, pushToolCallId, popToolCallId } from "./src/tool-store.js";

type SubagentDisplayInfo = {
  agentId: string;
  label: string;
};

const subagentDisplayByChildSessionKey = new Map<string, SubagentDisplayInfo>();

function emitSubagentStart(
  event: { agentId?: unknown; label?: unknown; childSessionKey?: unknown },
  requesterSessionKey?: string,
): void {
  if (!requesterSessionKey) {
    return;
  }
  const writer = getWriter(requesterSessionKey);
  if (!writer) {
    return;
  }
  const agentId = typeof event.agentId === "string" && event.agentId ? event.agentId : "subagent";
  const label = typeof event.label === "string" && event.label ? event.label : agentId;
  const childSessionKey =
    typeof event.childSessionKey === "string" ? event.childSessionKey : undefined;
  if (childSessionKey) {
    subagentDisplayByChildSessionKey.set(childSessionKey, { agentId, label });
  }
  writer({
    type: "subagent_start",
    agentId,
    label,
    childSessionKey,
  });
}

export function registerStreamingToolHooks(api: Pick<OpenClawPluginApi, "on">): void {
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

  api.on("subagent_spawning", (event, ctx) => {
    emitSubagentStart(event, ctx.requesterSessionKey);
  });

  api.on("subagent_spawned", (event, ctx) => {
    emitSubagentStart(event, ctx.requesterSessionKey);
  });

  api.on("subagent_ended", (event, ctx) => {
    const requesterSessionKey = ctx.requesterSessionKey;
    if (!requesterSessionKey) {
      return;
    }
    const writer = getWriter(requesterSessionKey);
    if (!writer) {
      return;
    }
    const display = subagentDisplayByChildSessionKey.get(event.targetSessionKey);
    const subagentId =
      display?.agentId ?? event.targetSessionKey.split(":subagent:").pop() ?? event.targetSessionKey;
    const label = display?.label ?? subagentId;
    subagentDisplayByChildSessionKey.delete(event.targetSessionKey);
    writer({
      type: "subagent_end",
      agentId: subagentId,
      label,
      childSessionKey: event.targetSessionKey,
      status: event.outcome === "ok" || event.reason === "subagent-complete" ? "success" : (event.outcome ?? event.reason),
    });
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
