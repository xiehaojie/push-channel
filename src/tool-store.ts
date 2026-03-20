/**
 * Per-session store for SSE writers and pending tool call IDs.
 * Used by before_tool_call / tool_result_persist hooks to emit
 * tool_call / tool_result events into the active SSE stream.
 *
 * No AG-UI dependency — events use a plain JSON envelope.
 */

export type SseWriter = (event: Record<string, unknown>) => void;

const writerStore = new Map<string, SseWriter>();

// --- SSE writer ---

export function setWriter(sessionKey: string, writer: SseWriter): void {
  writerStore.set(sessionKey, writer);
}

export function getWriter(sessionKey: string): SseWriter | undefined {
  return writerStore.get(sessionKey);
}

export function clearWriter(sessionKey: string): void {
  writerStore.delete(sessionKey);
  pendingStacks.delete(sessionKey);
}

// --- Pending toolCallId stack ---
// before_tool_call pushes, tool_result_persist pops.

const pendingStacks = new Map<string, string[]>();

export function pushToolCallId(sessionKey: string, toolCallId: string): void {
  let stack = pendingStacks.get(sessionKey);
  if (!stack) {
    stack = [];
    pendingStacks.set(sessionKey, stack);
  }
  stack.push(toolCallId);
}

export function popToolCallId(sessionKey: string): string | undefined {
  const stack = pendingStacks.get(sessionKey);
  const id = stack?.pop();
  if (stack && stack.length === 0) {
    pendingStacks.delete(sessionKey);
  }
  return id;
}
