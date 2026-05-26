# push-channel × Feishu 功能差距实施方案

> 本文档逐项列出 push-channel 相比 OpenClaw 官方 `extensions/feishu` 缺失的功能，
> 并为每一项给出落地方案（涉及的文件、协议变更、关键代码骨架、配置 Schema、依赖、测试）。
>
> 优先级标注：
> - **P0**：影响安全/隔离/可用性，必须先做
> - **P1**：常用对话能力，建议尽快补齐
> - **P2**：增强体验，按需求节奏推进
> - **P3**：高级/外围能力（多账户、生产力工具），可按需选做
>
> 路径约定：
> - 扩展代码根：`extensions/push-channel/src/`
> - 中台后端：`extensions/push-channel/admin-backend/`
> - 前端 SDK：`extensions/push-channel/frontend-demo/`

---

## 0. 全局协议改造

### 0.1 WebSocket 消息类型扩展（P0）

**目标**：当前 push-channel 仅支持纯文本消息推送；需要扩展为通用消息封包，承载多种事件。

**协议设计**（`admin-backend/src/websocket/protocol.ts`，新文件）：

```ts
// 客户端 → 服务端
type ClientEvent =
  | { type: "text"; text: string; chatId?: string; topicId?: string; replyToId?: string; mentions?: string[] }
  | { type: "media"; mediaType: "image" | "file" | "voice"; uploadId: string; filename?: string; caption?: string; chatId?: string; replyToId?: string }
  | { type: "reaction"; targetMessageId: string; emoji: string; op: "add" | "remove" }
  | { type: "edit"; messageId: string; text: string }
  | { type: "pin"; messageId: string; op: "pin" | "unpin" }
  | { type: "menu_click"; menuKey: string; chatId?: string }
  | { type: "card_action"; cardId: string; actionId: string; payload?: Record<string, unknown> }
  | { type: "typing"; chatId: string; state: "start" | "stop" }
  | { type: "ack"; messageId: string };

// 服务端 → 客户端
type ServerEvent =
  | { type: "text"; messageId: string; text: string; chatId?: string; meta?: Record<string, unknown> }
  | { type: "media"; messageId: string; mediaType: "image" | "file" | "voice"; downloadUrl: string; filename?: string; sizeBytes?: number }
  | { type: "card"; messageId: string; cardSchema: object; streaming?: boolean; sequence?: number; final?: boolean }
  | { type: "card_update"; messageId: string; patch: object; sequence: number; final?: boolean }
  | { type: "typing"; chatId: string; state: "start" | "stop" }
  | { type: "edit"; messageId: string; text: string }
  | { type: "delete"; messageId: string }
  | { type: "error"; code: string; message: string; refId?: string };
```

**实现要点**：
- 通过 `type` 字段路由；老的纯文本格式（无 `type` 字段）走兼容分支
- 引入 zod schema 校验客户端入站事件（`extensions/push-channel/admin-backend/src/websocket/schema.ts`）
- 出站事件必须带 `messageId`（雪花/uuidv7）用于幂等

**测试**：
- 单测：每种事件 schema 解析正确/拒绝非法字段
- 集成：模拟前端发送各类型事件，断言后端事件分发器调用对应 handler

### 0.2 中台后端事件总线（P0）

**目标**：解耦 WebSocket 接入层与 OpenClaw 插件的转换层，便于以后多协议接入（HTTP/WS/SSE）。

**新文件**：
- `admin-backend/src/bus/eventBus.ts`：基于 `node:events` 或 `mitt` 的 typed emitter
- `admin-backend/src/bus/types.ts`：内部事件类型（`message.in`, `message.out`, `session.start` 等）

**改造点**：
- `websocket/index.js` 收到客户端事件 → 校验 → 发到 bus
- `extensions/push-channel/src/channel.ts` 订阅 bus → 转为 OpenClaw `IncomingMessage`

---

## 1. 消息接收能力

### 1.1 群聊（多人会话）（P1）

**目标**：当前 push-channel 是 1:1 推送通道；增加“会话/群”概念，支持多个用户共享同一会话。

**实施方案**：
- DB Schema：新增 `chats` 表（`id`, `kind` enum(`dm`,`group`), `title`, `owner_user_id`, `created_at`）
  - 新增 `chat_members` 表（`chat_id`, `user_id`, `role` enum(`owner`,`member`)）
  - `messages` 表追加 `chat_id`
- 文件：
  - `admin-backend/src/mysql/init.sql`（追加表）
  - `admin-backend/src/controllers/chatController.js`（创建/邀请/退出）
  - `admin-backend/src/routes.js`（`POST /api/chats`、`POST /api/chats/:id/invite`、`DELETE /api/chats/:id/members/:uid`）
- 通道层（`extensions/push-channel/src/channel.ts`）：
  - 将 `senderId` 从“用户 ID”改为复合 `chatId:userId`
  - `runtimeId` 派生自 `chatId`（确保群里所有人共享同一个 agent session）
- 前端 SDK（`frontend-demo/sdk.js`）：
  - `client.join(chatId)`, `client.leave(chatId)`，订阅时附带 `chatId`

**配置 Schema**（`extensions/push-channel/src/config.ts`）：

```ts
{
  defaultChatKind: { type: "string", enum: ["dm", "group"], default: "dm" },
  enableGroupChat: { type: "boolean", default: false }
}
```

**测试**：
- 集成：两个 WS 连接加入同一 `chatId`，A 发消息 → B/agent 都能收到；agent 回复 → A 和 B 都看到

### 1.2 引用消息上下文（P1）

**目标**：用户引用某条历史消息时，把被引用消息文本作为上下文塞给 agent，等同 Feishu 的 quoted message。

**实施方案**：
- WS 协议字段：`ClientEvent.text.replyToId`
- 后端在 `bus` 中查询 `messages` 表（`SELECT text, sender_id FROM messages WHERE id = ?`），组装为：

  ```
  [引用] @sender: <被引内容前 200 字>
  ---
  <当前消息文本>
  ```
- 文件：`extensions/push-channel/src/channel.ts` 增加 `formatQuotedContext()` 工具
- 前端：消息列表支持长按/右键“引用”，发送时带 `replyToId`

**测试**：
- 单测：`formatQuotedContext` 处理空引用、过长引用截断、引用消息已删除
- 集成：发起带引用的消息，断言 agent 收到的 `prompt` 含引用块

### 1.3 主题/线程历史预注入（P1）

**目标**：对应 Feishu `topicId` 会话拓扑；push-channel 增加“话题”概念，新成员进入或重启 agent 时回放最近 N 条历史。

**实施方案**：
- DB：`messages` 表加 `topic_id`；新增 `topics` 表
- 通道：
  - 引入 `sessionScope` 配置：`chat | chat_topic | chat_user | chat_topic_user`（参照 Feishu `policy.ts`）
  - 在 `channel.ts.openSession()` 中按 scope 决定 `runtimeId`
  - Session 首次创建时通过 `fetchRecentMessages(chatId, topicId, limit=20)` 注入到 agent 初始 prompt
- 文件：
  - `extensions/push-channel/src/policy.ts`（新文件，仿 Feishu）
  - `extensions/push-channel/src/conversation-id.ts`（新文件，scope → runtimeId 解析）
  - `admin-backend/src/controllers/messageController.js` 增加 `listRecent({chatId, topicId, limit})`

**测试**：
- 单测：各 scope 输入相同 chat/topic/sender 时返回的 runtimeId 一致；不同维度时分裂
- 集成：开新 session 后 agent 第一次 prompt 含历史 N 条

### 1.4 多媒体消息接收（图片/文件/语音）（P0）

**目标**：客户端可发图片/文件/语音；通道把媒体下载、转 OpenClaw 标准附件传给 agent。

**实施方案**：

**(a) 上传（前端 → 中台后端）**
- HTTP 端点：`POST /api/uploads`（multipart/form-data，字段 `file`）
- 返回：`{ uploadId, mediaType, filename, sizeBytes, mimeType }`
- 后端存储路径：`UPLOAD_DIR/<yyyy-mm-dd>/<uploadId>.<ext>`（环境变量配置）
- 文件：
  - `admin-backend/src/controllers/uploadController.js`
  - `admin-backend/src/middleware/upload.js`（基于 `@koa/multer`）
  - DB：`uploads` 表（`id`, `user_id`, `chat_id?`, `path`, `mime`, `size`, `created_at`, `consumed_at?`）

**(b) 引用上传到聊天**
- WS 客户端事件：`{ type: "media", uploadId, mediaType, filename, chatId }`
- 后端校验 `uploads.user_id === ws.userId` 且未消费 → 标记 `consumed_at = now()`

**(c) 通道转换为 OpenClaw 附件**
- 文件：`extensions/push-channel/src/media.ts`（新文件）
- 复用 `openclaw/plugin-sdk/media-store` 的 `saveMediaStream`/`saveMediaBuffer`
- 图片：直接作为 `image` 附件
- 文件：作为 `file` 附件
- 语音：调用 `whisperTranscribe`（见 1.4.d）后，把识别文本拼到 `prompt`，同时把原始音频附加（让 agent 自行选择）

**(d) 语音转写**
- 复用 OpenClaw 已有的 STT 能力；如无，调用 OpenAI Whisper API
- 配置：`voiceTranscription.{enabled, provider, apiKey, language}`
- 文件：`extensions/push-channel/src/voice-transcribe.ts`

**(e) 安全**
- 文件名按 Feishu `sanitizeFileNameForUpload()` 同款处理：`value.replace(/[\p{Cc}"\\]/gu, "_")`（CWE-93）
- 上传大小限制（默认 50MB，配置 `media.maxUploadBytes`）
- MIME 白名单
- 路径白名单：`localRoots = [UPLOAD_DIR]`，所有 `loadWebMedia` 限制在内（防 CVE-2026-26321）

**测试**：
- 单测：`sanitizeFileNameForUpload`、`detectMediaType`、`isVoiceAudio`
- 集成：上传 PNG → 发消息 → agent 收到 image 附件；上传 mp3 → 转写文本+音频附件

### 1.5 转发消息展开（P2）

**目标**：用户转发一组消息时，按时间序展开为单独条目入 prompt。

**实施方案**：
- WS 事件：`{ type: "forward", messageIds: string[], chatId }`
- 后端 `messageController.listByIds()` 拉取，按时间排序
- 通道层格式化：

  ```
  [转发自 @user 的 3 条消息]
  1. 2026-05-26 10:01 @alice: hello
  2. 2026-05-26 10:02 @bob: world
  3. 2026-05-26 10:03 @alice: bye
  ```

**测试**：集成：构造 3 条历史消息，发送 forward 事件 → agent prompt 含展开块

### 1.6 @mention 触发（P1）

**目标**：群聊场景，仅当 agent 被 @ 时才回复（避免每条都触发）。

**实施方案**：
- WS `text.mentions: string[]`（被 @ 用户的 ID）
- 通道层在 `channel.ts.shouldRespond()` 中判断：
  - DM：始终响应
  - 群：只在 `mentions.includes(AGENT_USER_ID)` 或消息以 `/` 开头时响应
- 配置：`mentionMode: "always" | "mention_only" | "command_only"`

**测试**：单测覆盖 3 种 mode × DM/群组合

### 1.7 表情回应事件（P2）

**目标**：用户对消息加表情时，通知 agent（可选触发）。

**实施方案**：
- WS 事件：`reaction` 已定义
- 后端持久化：`reactions` 表（`message_id`, `user_id`, `emoji`, `created_at`）
- 通道层：默认不触发 agent；若配置 `reactionsAsEvents=true`，转为 `[用户 @x 对消息 #abc 加了 👍]` 注入

**测试**：集成：发 reaction 事件，DB 写入正确；启用 reactionsAsEvents 后 agent 收到通知

### 1.8 菜单按钮点击（P2）

**目标**：对应 Feishu 应用菜单；前端展示一组预设按钮，点击转为指令。

**实施方案**：
- WS 事件：`menu_click`（已定义）
- 后端配置菜单清单：`extensions/push-channel/src/config.ts` 中 `menuItems: Array<{ key, label, command }>`
- 通道层：把 `command` 字符串作为 user message 发给 agent

**测试**：单测菜单解析；集成点击 → agent prompt

---

## 2. 消息发送能力

### 2.1 卡片消息（结构化 UI）（P1）

**目标**：agent 可发送结构化卡片（按钮、表单、富文本），不仅是纯文本。

**实施方案**：
- 设计 push-channel 卡片 schema（参考 AdaptiveCards 子集或 Feishu Card Kit 简化版）：

  ```ts
  type Card = {
    version: "1.0";
    header?: { title: string; subtitle?: string; color?: string };
    body: Array<TextBlock | ImageBlock | ButtonGroup | InputField | Divider>;
    actions?: Array<{ id: string; label: string; style?: "primary"|"danger" }>;
  };
  ```
- 出站：WS `ServerEvent.card`
- 前端 SDK：`client.on("card", (msg) => render(msg.cardSchema))`，提供默认 React/纯 DOM 渲染器
- 通道层：暴露 `sendCard(card)` 给 agent（通过 OpenClaw plugin SDK 的 `channel.sendStructured`）
- 文件：
  - `extensions/push-channel/src/card.ts`（card 渲染辅助、按钮回调注册）
  - `frontend-demo/card-renderer.js`

**测试**：
- 单测：卡片 schema 校验（zod）
- 集成：agent 发卡片 → 前端收到，点击按钮 → 后端 `card_action` 事件触发 agent

### 2.2 流式卡片（P2）

**目标**：长回答边生成边更新（不闪烁），对应 Feishu Card Kit Streaming。

**实施方案**：
- 引入 `card_update` 事件，按 `sequence` 单调递增
- 通道层提供 `streamCard(cardId, async function*(emit) { ... })` API
  - 内部按时间窗口（默认 200ms）合并 patch，调用 `emit({ patch, sequence })`
- 前端按 `sequence` 应用 patch（JSON Patch 或自定义 path-based diff）
- 文件：`extensions/push-channel/src/streaming-card.ts`

**测试**：模拟 agent 流式输出 10 个 token，前端最终卡片 == 全量 schema

### 2.3 消息编辑（P2）

**目标**：agent 输出后可修订（纠错/补充）。

**实施方案**：
- WS `ServerEvent.edit`（已定义）
- 后端：`UPDATE messages SET text=?, edited_at=NOW() WHERE id=?`
- 前端：替换 DOM 节点内容，加 `(已编辑)` 标记
- 通道 API：`channel.editMessage(messageId, newText)`

**测试**：集成：发 → 编辑 → 前端收到 edit 事件并更新

### 2.4 消息固定（P3）

**目标**：在会话中置顶重要消息。

**实施方案**：
- DB：`pins` 表（`chat_id`, `message_id`, `pinned_by`, `pinned_at`）
- WS 事件：`pin`（已定义）
- HTTP：`GET /api/chats/:id/pins` 拉取置顶列表
- 通道 API：`channel.pinMessage(messageId)`

**测试**：单测增删；集成 agent 调用 pin → 前端 pins 列表更新

### 2.5 表情回应（出站）（P3）

**目标**：agent 给某条消息加表情（不是回复一条新消息）。

**实施方案**：
- 复用 1.7 的 reactions 表
- 通道 API：`channel.react(messageId, emoji, op)`
- WS 出站事件：`{ type: "reaction", messageId, emoji, op, by: "agent" }`

**测试**：集成 agent react → 前端 UI 更新

### 2.6 线程回复（P2）

**目标**：以线程形式而非顶级消息回复（关联 `replyToId`）。

**实施方案**：
- `ServerEvent.text` 增加 `replyToId?: string`、`threadRoot?: string` 字段
- DB：`messages` 表加 `reply_to_id`、`thread_root_id`
- 通道 API：`channel.sendText(text, { replyTo: messageId })`
- 前端：缩进或独立线程视图渲染

**测试**：单测 thread_root 推导（如果 reply 的 parent 也有 thread_root，复用之）

### 2.7 多媒体发送（P0）

**目标**：agent 输出图片/文件/语音给前端。

**实施方案**：

**(a) 上传到中台**
- 通道内部 HTTP：`POST /internal/uploads`（来自 OpenClaw 进程，鉴权用 `INTERNAL_TOKEN`）
- 入参：`{ source: "url"|"path"|"buffer", value, mediaType, filename? }`
- 后端下载/复制到 `UPLOAD_DIR`，返回 `{ downloadUrl }`

**(b) 通道层 API**
- 文件：`extensions/push-channel/src/send.ts`（扩展现有 send）
- `sendMedia(opts: { mediaType, source, filename?, caption?, transcodeVoice?: boolean })`
- 复用 plugin-sdk 的 `loadWebMedia({ localRoots: [UPLOAD_DIR] })`

**(c) 语音特殊处理**
- 若 `mediaType=voice` 且源不是 `.opus/.ogg`：调用 ffmpeg 转码（48kHz/mono/Opus/64kbps），完全照搬 Feishu `transcodeToFeishuVoiceOpus`
- 文件：`extensions/push-channel/src/voice-encode.ts`
- 依赖：ffmpeg 可执行；通过 `which ffmpeg` 或 `ffmpeg-static` 包

**(d) WS 出站**
- `ServerEvent.media` 已定义
- `downloadUrl` 走 `/api/downloads/:uploadId`，鉴权（仅会话成员可下）

**(e) 安全**
- 同 1.4：sanitize 文件名，大小限制，MIME 白名单，路径白名单

**测试**：
- 单测：voice 转码触发条件
- 集成：agent 发 image URL → 前端 image 事件 → GET downloadUrl 拿到字节
- 集成：agent 发 mp3 → 后端转码 → 前端收到 opus 文件

### 2.8 输入指示（typing）（P1）

**目标**：agent 开始思考/工具调用时，前端显示“正在输入...”。

**实施方案**：
- WS 事件：`typing`（已定义）
- 通道层：
  - `before_tool_call` hook → `typing.start`
  - `tool_result_persist` 或 `assistant_message_complete` → `typing.stop`
  - 加节流（最少 500ms 间隔）
- 文件：`extensions/push-channel/src/typing.ts`

**测试**：集成：触发工具调用 → 前端收到 start/stop 一对事件

---

## 3. 高级架构能力

### 3.1 多账户配置（P3）

**目标**：单个通道实例服务多个 push-channel 账户（不同前端/客户）。

**实施方案**：
- 配置：`accounts: Array<{ id, name, listenPath, middlewareUrl, overrides?: Partial<ChannelConfig> }>`
- 文件：
  - `extensions/push-channel/src/accounts.ts`（仿 Feishu 同名）
  - 改造 `index.ts` 的 `defineBundledChannelEntry`：注册多个 channel，每个 account 一个
- 路由：`listenPath` 必须唯一；前端按 path 区分

**测试**：启动 2 个 account 配置，分别 WS 连接，互不串扰

### 3.2 动态 agent 创建（P2）

**目标**：每个新用户（DM）首连时自动创建专属 agent runtime，不需要手工配置。

**实施方案**：
- 文件：`extensions/push-channel/src/dynamic-agent.ts`
- 在 `channel.openSession()` 中：
  - 查 DB 是否已有 `(account_id, user_id) → agent_id` 映射
  - 若无：调用 plugin-sdk 的 `runtime.createAgent({ template: config.dynamicAgent.template, name: userDisplay })`
  - 写入 DB `dynamic_agents` 表
- 配置：`dynamicAgent: { enabled, template, namePattern: "push-${userName}" }`

**测试**：新用户 WS 连接 → DB 创建记录 → 第二次连接复用

### 3.3 广播模式（P3）

**目标**：一条用户消息扇出到多个 agent；agent 回复聚合或并列返回。

**实施方案**：
- 配置：`broadcast: { enabled, agents: string[], mode: "parallel" | "serial", aggregator?: "first" | "all" }`
- 通道：在 `channel.dispatch()` 中并行调用 `agentA.run()`/`agentB.run()`，按 mode 处理
- WS 出站：每条回复带 `meta.agentId` 让前端分组

**测试**：集成 2 个 agent 并行 → 前端收到 2 条带 agentId 的消息

### 3.4 访问控制（policy）（P0）

**目标**：限制谁可使用 / 谁可写入 / 群聊白名单。当前 push-channel 仅 JWT 鉴权，缺乏细粒度授权。

**实施方案**：
- 文件：`extensions/push-channel/src/policy.ts`
- 配置 Schema：

  ```ts
  policy: {
    allowedUserIds?: string[]
    blockedUserIds?: string[]
    allowedChatIds?: string[]
    requireAdminApproval?: boolean
    maxMessagesPerMinute?: number
    maxMessagesPerDay?: number
  }
  ```
- 在 `channel.shouldAccept()` 中检查；不通过返回 `error` 事件而非静默丢弃
- 加 `rate-limit` 中间件（基于 redis 或内存 LRU，配置 `rateLimit.backend`）

**测试**：单测黑/白名单组合；集成超限返回 429 等价错误

### 3.5 会话 scope 模式（P1）

**目标**：可配置 session 边界（按聊天/按主题/按发送者/三者组合），见 1.3。

**实施方案**：见 1.3。独立列出因为这是架构级开关，影响 runtime/agent 隔离。

**配置**：`sessionScope: "chat" | "chat_topic" | "chat_sender" | "chat_topic_sender"`

### 3.6 子 agent 生命周期 hook（P2）

**目标**：agent 启动子任务（subagent）时通知前端，并可在卡片上显示子任务进度。

**实施方案**：
- 订阅 plugin-sdk 的 `subagent.start` / `subagent.progress` / `subagent.complete` 事件
- 文件：`extensions/push-channel/src/subagent-hooks.ts`
- 出站：`card_update` 推送子任务进度行

**测试**：模拟 subagent emit 3 个 progress → 前端 card 内 progress block 累积

### 3.7 审批卡片（P3）

**目标**：agent 执行高风险动作前发审批卡片，等待用户点“通过/拒绝”。

**实施方案**：
- 文件：`extensions/push-channel/src/approval.ts`
- API：`await channel.requestApproval({ title, body, timeoutMs })` → 返回 `"approved" | "rejected" | "timeout"`
- 内部：发 card → 注册 pending promise（按 `cardId` 索引）→ 收到 `card_action` 时 resolve
- 持久化 pending 状态到 DB，防止重启丢失

**测试**：集成 approval → 模拟用户点击 → promise resolve；超时返回 timeout

---

## 4. 生产力工具（Feishu 专有，按需移植）

> 这一类是 Feishu 与飞书云文档/多维表格/知识库的集成；对 push-channel 而言不必移植，
> 除非你要把"中台后端"做成自有的知识/文档系统。下文给出最小可行映射方案。

### 4.1 文档（push_doc）（P3）

**目标**：暴露给 agent 一组工具，让其读写中台侧的"文档"。

**实施方案**：
- 中台后端实现一套简化文档 API：
  - `POST /api/docs`、`GET /api/docs/:id`、`PATCH /api/docs/:id`、`DELETE /api/docs/:id`
  - 文档存储：MySQL 或对接外部 wiki
- 通道注册工具：`extensions/push-channel/src/tools/doc.ts`，actions：`create | read | update | append | delete | list`
- 鉴权：使用调用方 user 的 JWT 校验文档归属

**测试**：每个 action 一个集成用例，覆盖 happy path + 权限拒绝

### 4.2 知识库（push_wiki）（P3）

**实施方案**：
- 类似 4.1，actions：`search | get | create_page | update_page | list_spaces | move_page`
- 文件：`extensions/push-channel/src/tools/wiki.ts`
- 后端：`wiki_spaces`、`wiki_pages` 表；全文搜索用 MySQL FULLTEXT 或外接 Meilisearch

### 4.3 文件云盘（push_drive）（P3）

**实施方案**：
- 与上传/下载（1.4/2.7）共用底层
- 工具 actions：`upload | download | list | delete | move | rename | share | get_meta | search`
- 文件：`extensions/push-channel/src/tools/drive.ts`

### 4.4 表格（push_bitable）（P3）

**实施方案**：
- 中台后端实现轻量表格（"app + table + record"模型），存 MySQL JSON 列
- 工具：`create_app | list_tables | add_record | query_records | update_record | delete_record | add_field | list_fields`
- 文件：`extensions/push-channel/src/tools/bitable.ts`

### 4.5 权限管理（push_perm）（P3）

**实施方案**：
- DB：`resource_permissions` 表（`resource_type`, `resource_id`, `subject_type`, `subject_id`, `role`）
- 工具 actions：`grant | revoke | list`
- 文件：`extensions/push-channel/src/tools/perm.ts`

---

## 5. 实施顺序建议

按"安全 → 体验 → 生态"次序：

1. **第一阶段（P0，2-3 周）**
   - 0.1 WS 协议改造
   - 0.2 事件总线
   - 1.4 多媒体接收
   - 2.7 多媒体发送
   - 3.4 访问控制 + 限流

2. **第二阶段（P1，2-3 周）**
   - 1.1 群聊
   - 1.2 引用消息
   - 1.3 / 3.5 主题历史 + session scope
   - 1.6 @mention
   - 2.1 卡片消息
   - 2.8 typing 指示

3. **第三阶段（P2，按需）**
   - 1.5 转发展开
   - 1.7 入站表情
   - 1.8 菜单按钮
   - 2.2 流式卡片
   - 2.3 消息编辑
   - 2.6 线程回复
   - 3.2 动态 agent
   - 3.6 子 agent hooks

4. **第四阶段（P3，长尾）**
   - 2.4 消息固定
   - 2.5 出站表情
   - 3.1 多账户
   - 3.3 广播
   - 3.7 审批卡片
   - 4.1–4.5 生产力工具

---

## 6. 公共依赖与基础设施

### 6.1 依赖增加

```jsonc
// extensions/push-channel/package.json
{
  "dependencies": {
    "zod": "^3.x",
    "ffmpeg-static": "^5.x",
    "mime-types": "^2.x"
  }
}

// admin-backend/package.json
{
  "dependencies": {
    "@koa/multer": "^3.x",
    "rate-limiter-flexible": "^5.x"
  }
}
```

### 6.2 配置文件分层

最终 `~/.openclaw/credentials/push-channel.json`（示例，含合成占位值）：

```jsonc
{
  "listenPort": 3002,
  "listenPath": "/webhook",
  "middlewareUrl": "http://127.0.0.1:3001",
  "internalToken": "<random 32 bytes hex>",

  "sessionScope": "chat",
  "enableGroupChat": true,
  "mentionMode": "mention_only",

  "media": {
    "uploadDir": "~/.openclaw/data/push-channel/uploads",
    "maxUploadBytes": 52428800,
    "allowedMimes": ["image/*", "audio/*", "application/pdf", "text/*"]
  },
  "voiceTranscription": { "enabled": false },

  "policy": {
    "allowedUserIds": [],
    "maxMessagesPerMinute": 30,
    "rateLimit": { "backend": "memory" }
  },

  "dynamicAgent": { "enabled": false },
  "broadcast": { "enabled": false },

  "accounts": []
}
```

### 6.3 数据库迁移

新增 `admin-backend/src/mysql/migrations/`：

- `001_chats.sql`：`chats`, `chat_members`
- `002_topics.sql`：`topics`, `messages.topic_id`
- `003_uploads.sql`：`uploads`
- `004_reactions.sql`：`reactions`
- `005_pins.sql`：`pins`
- `006_dynamic_agents.sql`：`dynamic_agents`
- `007_resource_perms.sql`：`resource_permissions`
- `008_wiki_docs_bitable.sql`：4.1–4.4 所需表

引入 `node-pg-migrate` 或简单脚本 `npm run migrate`。

### 6.4 测试基础设施

- **单测**：Vitest（与 OpenClaw 主仓一致）
- **集成**：起 admin-backend + push-channel 通道（in-process 模式），用 `ws` 客户端模拟前端
- **E2E**：可选 Playwright 跑 `frontend-demo`
- 在 `extensions/push-channel/test/` 下建立：
  - `helpers/factory.ts`（创建 user/chat/message 等 fixtures）
  - `helpers/ws-client.ts`（薄封装的测试 WS 客户端）
  - `integration/*.test.ts`

---

## 7. 风险与不做的事

**不建议照搬的部分**：
- Feishu 的 OAuth2 / tenant access token 体系：push-channel 已用 JWT，体系不同，强行映射无收益
- Feishu Card Kit 完整 schema（含 i18n、tab、column set 等）：用简化子集足够
- Feishu Open Platform 的复杂权限模型（v1/v2/v3）：push-channel 自有权限即可
- Feishu 专有事件（应用上下架、机器人加群等）：在 WS 模型里没有对应概念

**潜在风险**：
- WS 协议大改动需要前端 SDK 升级，建议加 `protocolVersion` 字段并保留至少 1 个版本的兼容期
- 媒体上传/下载需要持久化目录与磁盘配额；缺乏清理任务会撑爆磁盘 → 加 cron 清理 `consumed_at IS NULL AND created_at < NOW() - 24h`
- ffmpeg 不在所有用户机器上 → 提供 `ffmpeg-static` 兜底但镜像变大
- 动态 agent 在没有总额限制时可能被滥用 → 加 `dynamicAgent.maxPerAccount`

---

## 附录 A：与 Feishu 实现的对照表

| 能力 | Feishu 文件 | push-channel 对应位置（新建） |
|---|---|---|
| 媒体下载 | `extensions/feishu/src/media.ts:415` | `extensions/push-channel/src/media.ts` |
| 媒体上传 | `extensions/feishu/src/media.ts:595` | `extensions/push-channel/src/media.ts` |
| 语音转码 | `extensions/feishu/src/media.ts:927` | `extensions/push-channel/src/voice-encode.ts` |
| 卡片发送 | `extensions/feishu/src/send.ts` | `extensions/push-channel/src/card.ts` |
| 流式卡片 | `extensions/feishu/src/streaming-card.ts` | `extensions/push-channel/src/streaming-card.ts` |
| 卡片回调 | `extensions/feishu/src/card-action.ts` | `extensions/push-channel/src/card-action.ts` |
| 审批卡片 | `extensions/feishu/src/card-ux-approval.ts` | `extensions/push-channel/src/approval.ts` |
| Session scope | `extensions/feishu/src/policy.ts` + `conversation-id.ts` | `extensions/push-channel/src/policy.ts` + `conversation-id.ts` |
| 多账户 | `extensions/feishu/src/accounts.ts` | `extensions/push-channel/src/accounts.ts` |
| 动态 agent | `extensions/feishu/src/dynamic-agent.ts` | `extensions/push-channel/src/dynamic-agent.ts` |
| Subagent hooks | `extensions/feishu/src/subagent-hooks.ts` | `extensions/push-channel/src/subagent-hooks.ts` |

---

_End of plan. 每项后续落地请单开 issue/PR，并把对应"测试"小节升级为可执行用例。_
