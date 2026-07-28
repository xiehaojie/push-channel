# Push Channel Subagent Transcript Live Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream child agent session transcript updates back into the parent push-channel session without relying on child tool hooks as the primary content source.

**Architecture:** Push-channel will subscribe to `api.runtime.events.onSessionTranscriptUpdate` during `registerFull`. When an update belongs to a bound child session and includes an inline message, the existing transcript projection converts it into `subagent_message`, `subagent_tool_call`, or `subagent_tool_result`, and the existing delivery/dedupe path sends it to the parent session. Existing child tool hooks and end-of-session replay remain as fallback paths.

**Tech Stack:** TypeScript, OpenClaw plugin runtime events, Vitest, push-channel admin WebSocket/demo event rendering.

---

### Task 1: Prove transcript updates stream child messages into the parent session

**Files:**
- Modify: `index.test.ts`
- Modify: `index.ts`

- [ ] **Step 1: Write the failing test**

Add a test that registers `runtime.events.onSessionTranscriptUpdate`, spawns a child session, emits transcript updates for assistant text, tool call, and tool result, and asserts the parent stream receives `subagent_message`, `subagent_tool_call`, and `subagent_tool_result`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/run-vitest.mjs extensions/push-channel/index.test.ts --reporter=verbose`

Expected: FAIL because `registerStreamingToolHooks` currently ignores `api.runtime.events.onSessionTranscriptUpdate`.

- [ ] **Step 3: Implement transcript listener**

Update `registerStreamingToolHooks` to accept `runtime.events.onSessionTranscriptUpdate`. Register one listener that filters bound child session keys, converts the single `update.message` with `createSubagentEventsFromMessages`, skips delivered event keys, and calls `deliverSubagentEvent`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/run-vitest.mjs extensions/push-channel/index.test.ts --reporter=verbose`

Expected: PASS.

### Task 2: Keep lifecycle cleanup and fallback behavior safe

**Files:**
- Modify: `index.test.ts`
- Modify: `index.ts`

- [ ] **Step 1: Write the failing test**

Add assertions that duplicate transcript updates do not duplicate hook-delivered tool events, and that the runtime unsubscribe is registered through `api.lifecycle.registerRuntimeLifecycle`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/run-vitest.mjs extensions/push-channel/index.test.ts --reporter=verbose`

Expected: FAIL until cleanup registration exists.

- [ ] **Step 3: Implement lifecycle cleanup**

Store the unsubscribe returned by `onSessionTranscriptUpdate` and register it with `api.lifecycle.registerRuntimeLifecycle` when lifecycle API is present.

- [ ] **Step 4: Run targeted and integration checks**

Run:
`node scripts/run-vitest.mjs extensions/push-channel/index.test.ts extensions/push-channel/src/subagent-transcript-events.test.ts extensions/push-channel/src/outbound.test.ts --reporter=verbose`

Expected: PASS.

### Task 3: Final verification and memory update

**Files:**
- Modify: `PROJECT_MEMORY.md`

- [ ] **Step 1: Run full targeted verification**

Run:
`npm test -- --test-name-pattern "send broadcasts structured subagent|processSSEEvent preserves"`
from `extensions/push-channel/admin-backend`.

Run:
`pnpm tsgo:extensions:test`
from the OpenClaw repo root.

Run:
`node --check admin-backend/src/controllers/pushController.js admin-backend/src/websocket/index.js admin-backend/src/controllers/pushController.test.js admin-backend/src/websocket/index.test.js frontend-demo/sdk.js`
from `extensions/push-channel`.

Run:
`git -C /Users/xiehaojie/code/openclaw-new/openclaw-0601/openclaw/extensions/push-channel diff --check`

Expected: PASS.

- [ ] **Step 2: Update project memory**

Record that push-channel uses runtime transcript updates as the primary live child-session event source and keeps hooks/replay as fallback.
