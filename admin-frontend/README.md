# Admin Frontend

该目录是 push-channel 示例栈中的可选 Next.js 管理前端，不属于 OpenClaw 插件运行时。

## 职责

- 登录和会话界面。
- 用户和 Agent 管理页面。
- 面向 admin-backend 的 dashboard 页面。

## 依赖

- Node.js
- 已启动的 admin-backend，默认地址为 `http://localhost:3001`

后端 API 地址目前定义在 `src/lib/api.ts`。

## 启动

```bash
npm install
npm run dev
```

打开 `http://localhost:3000`。

## 脚本

```bash
npm run dev
npm run build
npm run start
npm run lint
```

## 说明

- API 请求默认发送到 `http://localhost:3001/api`。
- 登录 token 保存在浏览器 `localStorage` 中。
- UI 相关的安装、启动和排障说明请维护在本文件中，不要放到根目录 README。
