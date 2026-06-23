export type SubagentTranscriptEvent = Record<string, unknown> & {
  type: "subagent_message" | "subagent_tool_call" | "subagent_tool_result";
  agentId: string;
  label: string;
  childSessionKey: string;
};

type ProjectionParams = {
  messages: unknown[];
  agentId: string;
  label: string;
  childSessionKey: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeMessageEntry(entry: unknown): {
  messageId?: string;
  message?: Record<string, unknown>;
} {
  const record = asRecord(entry);
  if (!record) {
    return {};
  }

  const wrappedMessage = asRecord(record.message);
  const message = wrappedMessage ?? record;
  const id = typeof record.id === "string" ? record.id : undefined;
  return { messageId: id, message };
}

function contentBlocks(message: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(message.content)
    ? message.content.flatMap((block) => {
        const record = asRecord(block);
        return record ? [record] : [];
      })
    : [];
}

function textFromBlock(block: Record<string, unknown>): string | undefined {
  const text = typeof block.text === "string" ? block.text.trim() : "";
  return text ? text : undefined;
}

function partialArgsFromBlock(block: Record<string, unknown>): unknown {
  if (block.arguments !== undefined) {
    return block.arguments;
  }
  if (typeof block.partialArgs !== "string" || !block.partialArgs.trim()) {
    return {};
  }
  try {
    return JSON.parse(block.partialArgs);
  } catch {
    return { partialArgs: block.partialArgs };
  }
}

export function createSubagentEventsFromMessages(
  params: ProjectionParams,
): SubagentTranscriptEvent[] {
  const events: SubagentTranscriptEvent[] = [];
  for (const entry of params.messages) {
    const { messageId, message } = normalizeMessageEntry(entry);
    if (!message) {
      continue;
    }
    const role = typeof message.role === "string" ? message.role : "";

    if (role === "assistant") {
      const textBlocks: string[] = [];
      const assistantEvents: SubagentTranscriptEvent[] = [];
      for (const block of contentBlocks(message)) {
        const blockType = typeof block.type === "string" ? block.type : "";
        if (blockType === "text") {
          const content = textFromBlock(block);
          if (content) {
            textBlocks.push(content);
          }
        }
        if (blockType === "toolCall") {
          const toolCallId = typeof block.id === "string" ? block.id : undefined;
          const toolName = typeof block.name === "string" ? block.name : undefined;
          if (!toolCallId || !toolName) {
            continue;
          }
          assistantEvents.push({
            type: "subagent_tool_call",
            agentId: params.agentId,
            label: params.label,
            childSessionKey: params.childSessionKey,
            ...(messageId ? { messageId } : {}),
            toolCallId,
            toolName,
            args: partialArgsFromBlock(block),
          });
        }
      }
      if (textBlocks.length > 0) {
        events.push({
          type: "subagent_message",
          agentId: params.agentId,
          label: params.label,
          childSessionKey: params.childSessionKey,
          ...(messageId ? { messageId } : {}),
          content: textBlocks.join("\n\n"),
        });
      }
      events.push(...assistantEvents);
      continue;
    }

    if (role === "toolResult") {
      const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
      const toolName = typeof message.toolName === "string" ? message.toolName : undefined;
      if (!toolCallId || !toolName) {
        continue;
      }
      const payload: SubagentTranscriptEvent = {
        type: "subagent_tool_result",
        agentId: params.agentId,
        label: params.label,
        childSessionKey: params.childSessionKey,
        ...(messageId ? { messageId } : {}),
        toolCallId,
        toolName,
      };
      if (message.content !== undefined) {
        payload.content = message.content;
      }
      if (message.isError !== undefined) {
        payload.isError = Boolean(message.isError);
      }
      events.push(payload);
    }
  }
  return events;
}
