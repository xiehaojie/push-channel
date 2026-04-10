require('dotenv').config();
const Koa = require('koa');
const http = require('http');
const bodyParser = require('koa-bodyparser');
const cors = require('@koa/cors');
const serve = require('koa-static');
const path = require('path');
const { router } = require('./routes');
const { initWebSocket } = require('./websocket');
const { startWebDAVServer } = require('./controllers/fileController');
const { NacosNamingClient, NacosConfigClient } = require('nacos');
const nacosConfig = require('./config/nacos');
const { initDB } = require('./config/database');

const app = new Koa();

// Middleware
app.use(cors());
app.use(bodyParser());
app.use(serve(path.join(__dirname, '../public')));

// Routes
app.use(router.routes());
app.use(router.allowedMethods());

const server = http.createServer(app.callback());

// Initialize WebSocket（需要在 startServer 之前，因为 namingClient 需要 ready）
const namingClient = new NacosNamingClient({
    logger: console,
    serverList: nacosConfig.serverList,
    namespace: nacosConfig.namespace,
});

const PORT = process.env.PORT || 3001;

async function startServer() {
    try {
        const configClient = new NacosConfigClient({
            serverAddr: nacosConfig.serverList,
            namespace: nacosConfig.namespace, //
        });

        // get config
        console.log(`Getting config from Nacos: dataId=${nacosConfig.dataId}, group=${nacosConfig.group}`);
        const content = await configClient.getConfig(nacosConfig.dataId, nacosConfig.group);
        console.log('Raw config from Nacos:', content);

        if (!content) {
            throw new Error('Failed to get config from Nacos, content is empty.');
        }

        const dbConfig = JSON.parse(content);
        console.log('Parsed DB config:', dbConfig);

        // 设置 DEFAULT_DIR 环境变量（从 Nacos 配置读取）
        if (dbConfig.DEFAULT_DIR) {
            process.env.DEFAULT_DIR = dbConfig.DEFAULT_DIR;
        }

        await initDB(dbConfig);
        console.log('Database initialized');

        const client = new NacosNamingClient({
            logger: console,
            serverList: nacosConfig.serverList,
            namespace: nacosConfig.namespace,
        });
        await client.ready();

        await client.registerInstance(nacosConfig.serviceName, {
            ip: '127.0.0.1', //
            port: PORT,
        });

        console.log('Service registered to Nacos');

        // namingClient ready 后初始化 WebSocket
        await namingClient.ready();
        initWebSocket(server, namingClient, nacosConfig.userCenterServiceName);

        server.listen(PORT, () => {
            console.log(`Admin backend listening on port ${PORT}`);

            // 启动 WebDAV 服务器（暂时禁用）
            // startWebDAVServer();
        });

    } catch (error) {
        console.error('Failed to start server', error);
        process.exit(1);
    }
}

startServer();

