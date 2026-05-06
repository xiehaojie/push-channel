# Admin Backend

该目录是 push-channel 示例栈中的可选后台服务，不属于 OpenClaw 插件运行时。

## 职责

- 提供 `/api` 下的登录、注册、会话和用户管理接口。
- 使用 MySQL 存储用户和 Agent 信息。
- 通过 `/send` 接收插件外发消息。
- 维护浏览器客户端的 WebSocket 连接。
- 将浏览器消息转发到 OpenClaw push-channel webhook。

## 依赖

- Node.js
- MySQL 8，或使用本目录提供的 Docker Compose

## 配置

可用环境变量：

```bash
PORT=3001
DB_HOST=localhost
DB_PORT=3306
DB_USER=admin_user
DB_PASSWORD=admin_password
DB_NAME=admin_db
OPENCLAW_WEBHOOK_URL=http://localhost:3002/webhook
JWT_SECRET=change-me
```

默认值定义在 `src/app.js`、`src/config/database.js` 和 `src/websocket/index.js`。

## 启动

启动 MySQL：

```bash
docker compose up -d mysql
```

安装依赖并启动后台：

```bash
npm install
npm start
```

默认监听 `http://localhost:3001`。

## API

主要接口：

- `POST /api/auth/login`
- `POST /api/auth/register`
- `GET /api/auth/session`
- `POST /api/auth/logout`
- `GET /api/users`
- `POST /api/users`
- `PATCH /api/users/:id/status`
- `PUT /api/users/:id`

兼容旧 middleware 的接口：

- `POST /send`
- `POST /api/send`
- `POST /register`
- `POST /auth`

## 消息流

浏览器到 OpenClaw：

```text
WebSocket client -> admin-backend -> OPENCLAW_WEBHOOK_URL -> push-channel plugin
```

OpenClaw 到浏览器：

```text
push-channel plugin -> POST /send -> admin-backend -> WebSocket client
```
