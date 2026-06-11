# Push Channel Mention Subagent Visibility Design

## Goal

Support one push-channel session where the user mentions multiple required agents, the main agent orchestrates those required agents, and each subagent's execution progress is visible in the same WebSocket session.

## Confirmed Requirements

- `agentId` in the inbound message remains the main/orchestrator agent.
- Mentions are strong constraints: each mentioned agent must be executed by the orchestrator path.
- Results return to the original `sessionId`.
- Subagent lifecycle and progress must be visible through the current admin-backend WebSocket stream.
- Feishu is only a reference. Do not copy Feishu group/user mention semantics, `@all`, or dynamic user-agent creation.

## Inbound Contract

The WebSocket client may send mentions explicitly:

```json
{
  "type": "message",
  "content": "Ask @researcher to investigate and @coder to draft the change",
  "sessionId": "session-1",
  "mentions": [
    { "agentId": "researcher", "label": "researcher" },
    { "agentId": "coder", "label": "coder" }
  ]
}
```

For the demo, if `mentions` is absent, the frontend may parse plain `@agentId` tokens and send them as structured mentions. The backend also forwards `mentions` unchanged to the OpenClaw webhook.

## Event Contract

OpenClaw/push-channel SSE may emit:

```json
{ "type": "subagent_start", "agentId": "researcher", "label": "researcher" }
{ "type": "subagent_stream", "agentId": "researcher", "content": "Searching..." }
{ "type": "subagent_result", "agentId": "researcher", "content": "Findings..." }
{ "type": "subagent_error", "agentId": "researcher", "message": "Failure reason" }
{ "type": "subagent_end", "agentId": "researcher", "status": "success" }
```

`admin-backend` forwards these events as WebSocket messages scoped to the original `agentId + sessionId`, adding existing `queryMessageId` and `answerMessageId` metadata when available.

## Frontend Behavior

- Existing chat stream stays unchanged for the final main-agent answer.
- A mentioned subagent renders as a task card with agent label, status, progress text, result, and error state.
- Multiple mentioned agents can appear in the same session.
- Cards update in place using `agentId` and `sessionId`.

## Non-Goals

- No dropdown mention picker in this iteration.
- No Feishu-style user mentions, group mentions, or `@all`.
- No dynamic creation of new agents.
- No cross-session fanout.

## Validation

- Backend unit tests prove `mentions` are forwarded to OpenClaw and `subagent_*` SSE events become session-scoped WS messages.
- Frontend demo can display subagent lifecycle cards from WS events.
- Existing stream/tool events continue to work.
