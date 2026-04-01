require('dotenv').config();
const Koa = require('koa');
const http = require('http');
const bodyParser = require('koa-bodyparser');
const cors = require('@koa/cors');
const { router } = require('./routes');
const { initWebSocket } = require('./websocket');
const { NacosNamingClient, NacosConfigClient } = require('nacos');
const nacosConfig = require('./config/nacos');
const { initDB } = require('./config/database');

const app = new Koa();

// Middleware
app.use(cors());
app.use(bodyParser());

// Routes
app.use(router.routes());
app.use(router.allowedMethods());

const server = http.createServer(app.callback());

// Initialize WebSocket
initWebSocket(server);

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

        server.listen(PORT, () => {
            console.log(`Admin backend listening on port ${PORT}`);
        });

    } catch (error) {
        console.error('Failed to start server', error);
        process.exit(1);
    }
}

startServer();

