/**
 * Per-session store for SSE writers and pending tool call IDs.
 * Used by before_tool_call / tool_result_persist hooks to emit
 * tool_call / tool_result events into the active SSE stream.
 *
 * No AG-UI dependency — events use a plain JSON envelope.
 */

export type SseWriter = (event: Record<string, unknown>) => void;

type PushChannelToolStoreState = {
  writerStore: Map<string, SseWriter>;
  pendingStacks: Map<string, string[]>;
};

const PUSH_CHANNEL_TOOL_STORE_KEY = Symbol.for("openclaw.pushChannel.toolStore");

function getToolStoreState(): PushChannelToolStoreState {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const existing = globalStore[PUSH_CHANNEL_TOOL_STORE_KEY];
  if (existing) {
    return existing as PushChannelToolStoreState;
  }
  const created: PushChannelToolStoreState = {
    writerStore: new Map<string, SseWriter>(),
    pendingStacks: new Map<string, string[]>(),
  };
  globalStore[PUSH_CHANNEL_TOOL_STORE_KEY] = created;
  return created;
}

const state = getToolStoreState();
const writerStore = state.writerStore;
const pendingStacks = state.pendingStacks;

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
