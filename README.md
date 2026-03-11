
# OpenClaw Push Channel Plugin

这是一个演示如何为 OpenClaw 开发自定义 Channel 插件的示例。该插件实现了类似于飞书的主动推送功能，通过一个中间层服务（Middleware）与前端进行双向通信。

## 架构说明

1.  **OpenClaw Push Channel Plugin**:
    *   作为 OpenClaw 的一个扩展插件运行。
    *   **Outbound (发送)**: 当 OpenClaw 需要发送消息时，插件会将消息通过 HTTP POST 发送到 Middleware 服务。
    *   **Inbound (接收)**: 插件会启动一个 HTTP Server (默认端口 3002)，监听来自 Middleware 的 webhook 请求，并将消息转发给 OpenClaw Agent。

2.  **Middleware Service (中间层服务)**:
    *   位于 `middleware/` 目录。
    *   基于 Node.js + Express + Socket.io。
    *   维护与前端客户端的 WebSocket 连接（通过 `sessionId` 区分）。
    *   **接收 OpenClaw 消息**: 提供 `POST /send` 接口，接收 OpenClaw 推送的消息并通过 WebSocket 转发给指定前端。
    *   **接收前端消息**: 监听 WebSocket `message` 事件，将前端消息通过 HTTP POST 转发给 OpenClaw Plugin 的 webhook 接口。

3.  **Frontend Demo (前端示例)**:
    *   位于 `client/` 目录。
    *   简单的 HTML + Socket.io 客户端。
    *   连接到 Middleware 服务，使用指定的 `sessionId` 注册。
    *   可以发送和接收消息。

## 目录结构

```
extensions/push-channel/
├── client/              # 前端示例代码
│   └── index.html
├── middleware/          # 中间层服务代码
│   ├── package.json
│   └── server.js
├── src/                 # 插件源码
│   ├── channel.ts       # 插件定义
│   ├── monitor.ts       # 监听服务 (Inbound)
│   ├── outbound.ts      # 发送适配器 (Outbound)
│   ├── reply-dispatcher.ts # 回复调度器
│   ├── send.ts          # 发送逻辑
│   ├── types.ts         # 类型定义
│   └── runtime.ts       # 运行时辅助
├── index.ts             # 插件入口
├── package.json         # 插件配置
└── README.md            # 说明文档
```

## 使用步骤

### 1. 启动 Middleware 服务

```bash
cd extensions/push-channel/middleware
npm install
node server.js
# 服务将监听在 3001 端口
```

### 2. 配置 OpenClaw

在 OpenClaw 根目录下运行以下命令启用插件并配置：

```bash
# 启用插件
openclaw config set channels.push-channel.enabled true

# 配置 Middleware 地址 (OpenClaw -> Middleware)
openclaw config set channels.push-channel.middlewareUrl "http://localhost:3001"

# 配置插件监听端口 (Middleware -> OpenClaw)
openclaw config set channels.push-channel.listenPort 3002
openclaw config set channels.push-channel.listenPath "/webhook"
```

### 3. 运行 OpenClaw

启动 OpenClaw 开发服务：

```bash
pnpm dev
```

### 4. 运行前端 Demo

直接在浏览器中打开 `extensions/push-channel/client/index.html`。

1.  输入任意 `Session ID` (例如 `user-123`)。
2.  点击 **Connect**。
3.  连接成功后，你可以发送消息给 OpenClaw Agent。
4.  OpenClaw Agent 的回复也会通过 Middleware 推送到前端。

## 开发注意事项

*   **Session ID**: 前端指定的 Session ID 将作为 OpenClaw 中的 `peerId`，用于区分不同的用户会话。
*   **端口冲突**: 请确保端口 3000 (Plugin) 和 3001 (Middleware) 未被占用，或在配置中修改。
*   **网络连通性**: 如果 OpenClaw 和 Middleware 运行在不同机器，请确保网络互通，并配置正确的 IP 地址。
