# OpenClaw Push Channel 插件

`push-channel` 是一个 OpenClaw Channel 插件，用于把 OpenClaw Agent 接入外部推送或消息系统。根目录 README 只描述插件本体，不包含管理后台、前端管理页或浏览器 Demo 的启动说明。

插件负责：

- 启动 HTTP webhook 服务，接收外部用户消息。
- 将入站消息分发给指定的 OpenClaw Agent。
- 在 webhook 响应中通过 SSE 流式返回助手回复。
- 将非流式回复或主动外发消息推送到外部 middleware。
- 注册受约束的 `knowledge_search` 知识库检索工具。

其他模块说明请看对应目录：

- `admin-backend/README.md`
- `admin-frontend/README.md`
- `frontend-demo/README.md`

## 插件入口

插件入口文件是 `index.ts`。

```json
{
  "name": "push-channel",
  "main": "index.ts",
  "type": "module",
  "openclaw": {
    "extensions": ["./index.ts"],
    "channel": {
      "id": "push-channel",
      "label": "Push Channel"
    }
  }
}
```

## 能力边界

当前 channel 只支持 direct 文本会话。

暂不支持媒体、线程、投票、reaction、消息编辑、引用回复等能力。

## Channel 配置

Channel 运行配置位于 `channels.push-channel`。

```json
{
  "channels": {
    "push-channel": {
      "enabled": true,
      "middlewareUrl": "http://localhost:3001",
      "listenPort": 3002,
      "listenPath": "/webhook",
      "typingEnabled": false,
      "allowedSenders": []
    }
  }
}
```

字段说明：

- `enabled`: 是否启用 push-channel。
- `middlewareUrl`: 外部 middleware 的基础地址。插件会向 `${middlewareUrl}/send` 推送外发消息。
- `listenPort`: 插件 webhook 服务监听端口，默认 `3002`。
- `listenPath`: 插件 webhook 路径，默认 `/webhook`。
- `typingEnabled`: 预留的输入状态配置。
- `allowedSenders`: 预留的发送方白名单配置。

## 知识库工具

插件会注册 `knowledge_search` 工具。这个工具只用于检索已配置的知识库，不用于替代模型直接回答。

调用边界：

- 用户明确要求搜索知识库、内部文档时，可以调用。
- 非 skill 场景下，如果直接回答会不准确或模棱两可，且知识库可能有权威答案，可以调用。
- 执行 skill 时，只有当 skill 自带说明或参考内容无法回答关键细节时，才调用。
- 不要为了问候、确认、闲聊、简单命令、通用推理、代码任务、计算、翻译，或基于当前上下文可以可靠回答的问题调用。

知识库配置位于插件配置中，例如：

```json
{
  "plugins": {
    "entries": {
      "push-channel": {
        "config": {
          "knowledgeBase": {
            "enabled": true,
            "apiEndpoint": "https://example.com/api/retrieval",
            "datasetId": "your-dataset-id",
            "token": "your-api-token",
            "searchMethod": "hybrid_search",
            "topK": 5,
            "scoreThreshold": 0.3
          }
        }
      }
    }
  }
}
```

## 入站 Webhook 协议

外部服务通过插件 webhook 发送用户消息：

```http
POST http://localhost:3002/webhook
Content-Type: application/json
```

```json
{
  "agentId": "default",
  "sessionId": "user-or-conversation-id",
  "content": "你好"
}
```

必填字段：

- `agentId`: 目标 OpenClaw Agent ID。
- `content`: 用户消息文本。

可选字段：

- `sessionId`: 稳定的用户或会话 ID。不传时使用 `agentId` 作为会话 ID。

插件会把消息映射为 direct channel session：

```text
agent:{agentId}:channel:push-channel:direct:{sessionId}
```

## SSE 流式响应

当入站 webhook 响应保持打开时，插件会返回 Server-Sent Events。

事件示例：

```text
data: {"type":"content","delta":"你好"}

data: {"type":"tool_start"}

data: {"type":"tool_call","toolCallId":"tool-...","toolName":"knowledge_search","args":{"query":"..."}}

data: {"type":"tool_result","toolCallId":"tool-...","message":"..."}

data: {"type":"tool_end"}

data: {"type":"done"}
```

事件类型：

- `content`: 助手回复文本增量。
- `tool_start`: 工具执行阶段开始。
- `tool_call`: 发起了一次工具调用。
- `tool_result`: 工具结果已持久化。
- `tool_end`: 工具执行阶段结束。
- `timeout_deferred`: 工具仍在执行，超时提示被延后。
- `done`: 当前流结束。

## 外发 Middleware 协议

对于非流式回复和 channel 主动外发，插件期望 middleware 提供：

```http
POST {middlewareUrl}/send
Content-Type: application/json
```

```json
{
  "agentId": "default",
  "sessionId": "user-or-conversation-id",
  "content": "助手回复"
}
```

middleware 负责把消息继续投递给已连接的客户端或下游推送服务。

## 源码结构

```text
.
├── index.ts                  # 插件入口、hooks、工具注册
├── openclaw.plugin.json      # 插件 manifest 和配置 schema
├── package.json              # 包元信息
└── src
    ├── channel.ts            # Channel 元信息和账号配置
    ├── knowledge.ts          # 知识库检索客户端
    ├── monitor.ts            # Webhook 服务和入站分发
    ├── outbound.ts           # OpenClaw outbound adapter
    ├── reply-dispatcher.ts   # 流式回复和 middleware 回复分发
    ├── runtime.ts            # Runtime 桥接
    ├── send.ts               # Middleware POST 工具
    ├── tool-store.ts         # 按 session 存储工具事件 writer
    └── types.ts              # 插件配置和账号类型
```

## 开发注意事项

- 根 README 只维护插件行为、配置和协议说明。
- 后台、前端和 Demo 的安装启动说明放在各自目录 README 中。
- 知识库不可用时应 fail open，避免检索失败阻塞正常对话。
- 如果 `listenPort` 被占用，请先修改 channel 配置再启动 OpenClaw。
