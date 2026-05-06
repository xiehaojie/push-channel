# Frontend Demo

该目录是 push-channel 示例栈中的独立浏览器 Demo，不属于 OpenClaw 插件运行时。

## 文件

- `index.html`: 登录、注册和聊天 Demo 页面。
- `sdk.js`: 连接 admin-backend 的浏览器 WebSocket SDK。
- `style.css`: Demo 样式。

## 依赖

- admin-backend 运行在 `http://localhost:3001`。
- OpenClaw push-channel 插件监听在 admin-backend 的 `OPENCLAW_WEBHOOK_URL`，通常是 `http://localhost:3002/webhook`。

## 启动

可以直接用浏览器打开 `index.html`，也可以用任意静态文件服务器启动。

示例：

```bash
python3 -m http.server 8080
```

然后打开 `http://localhost:8080`。

## 消息流

```text
Browser demo -> WebSocket -> admin-backend -> OpenClaw webhook
OpenClaw plugin -> admin-backend /send -> WebSocket -> Browser demo
```

Demo 会展示插件返回的流式助手消息和工具生命周期事件。
