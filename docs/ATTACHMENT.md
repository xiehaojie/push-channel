# Push Channel 问题修复总结

## 问题 1 修复（真正的 token 流式）

- `reply-dispatcher.ts` — `createStreamingReplyDispatcher` 现在返回 `{ dispatcher, onPartialReply }`。`onPartialReply` 会在每个 token 到达时立即发送 SSE 事件，并设置 `hasStreamedContent = true`。`sendBlockReply` / `sendFinalReply` 检查此 flag，如果已经流式发送过内容则跳过，只发 `done`，避免重复。
- `monitor.ts` — 把 `onPartialReply` 传入 `replyOptions`，这样 OpenClaw 每生成一个 token 就会立即通过 SSE 推给 `websocket/index.js`，再转发到前端。

## 问题 2 修复（AbortError 报错）

- `admin-backend/src/websocket/index.js` — `res.body.on('error')` 现在区分 AbortError，正常中断只打 `log` 不打 `error`。

## 问题 3 修复（Outbound not configured for channel: push-channel）

- `outbound.ts` — 之前用的是旧接口（`send` 方法），`createPluginHandler` 找不到 `sendText` 导致报错。现在改为正确实现：`deliveryMode: "direct"` ✓、`sendText` 方法 ✓、从 `cfg` 读取 `middlewareUrl` ✓。

## 问题 4 修复（spawned session 推送到 `bot` 而非真实 sessionId）

- `monitor.ts` — 之前 `OriginatingTo: "bot"`，`resolveLastToRaw` 会把它存为 session 的 `lastTo`。当 reminder 等 spawned session 触发时，`resolveDeliveryTarget` 读到 `lastTo: "bot"`，导致 `outbound.sendText` 收到 `to=bot`，admin-backend 找不到对应 WebSocket session（404）。
- 修复：将 `OriginatingTo` 改为 `peerId`（真实用户 sessionId），session 正确记录回复目标，spawned session 推送路由到正确用户。
