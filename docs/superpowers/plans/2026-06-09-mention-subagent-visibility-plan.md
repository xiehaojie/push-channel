# Mention Subagent Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add structured mention forwarding and visible subagent execution events to push-channel's demo WebSocket path.

**Architecture:** Keep `push-channel` transport-focused. `admin-backend` forwards structured `mentions` and converts `subagent_*` SSE events to WS messages. `frontend-demo` parses simple `@agentId` mentions for demo use and renders subagent cards from WS events.

**Tech Stack:** Node.js `node:test` for admin-backend tests, vanilla JS frontend demo, TypeScript push-channel plugin.

---

### Task 1: Backend WS Event Contract

**Files:**
- Modify: `admin-backend/src/websocket/index.test.js`
- Modify: `admin-backend/src/websocket/index.js`

- [ ] Add a failing test proving `mentions` are forwarded in the webhook payload.
- [ ] Add a failing test proving `subagent_start`, `subagent_stream`, `subagent_result`, `subagent_error`, and `subagent_end` SSE events become WS events with `sessionId`.
- [ ] Implement minimal forwarding and SSE conversion.
- [ ] Run `npm test` in `admin-backend`.

### Task 2: Frontend Demo Visualization

**Files:**
- Modify: `frontend-demo/sdk.js`
- Modify: `frontend-demo/index.html`
- Modify: `frontend-demo/style.css`

- [ ] Add SDK callbacks for `subagent_*`.
- [ ] Parse simple `@agentId` tokens when sending a message and include `mentions`.
- [ ] Render and update subagent cards in the existing message list.
- [ ] Preserve current stream/tool UI.

### Task 3: Push Channel Mention Context

**Files:**
- Modify: `src/types.ts`
- Modify: `src/monitor.ts`
- Modify: `src/monitor.test.ts`
- Modify: `README.md`

- [ ] Extend inbound payload type with structured `mentions`.
- [ ] Inject required mentioned agents into the main agent body/context as a system instruction.
- [ ] Add a focused monitor test proving the instruction is present when mentions are supplied.
- [ ] Document the new inbound `mentions` contract and `subagent_*` SSE event contract.

### Task 4: Verification

**Files:**
- No code files unless fixes are needed.

- [ ] Run admin-backend tests.
- [ ] Run push-channel focused tests.
- [ ] Report any unverified live UI steps if a full OpenClaw runtime is unavailable.
