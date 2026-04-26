require('dotenv').config();
const Koa = require('koa');
const http = require('http');
const bodyParser = require('koa-bodyparser');
const cors = require('@koa/cors');
const serve = require('koa-static');
const path = require('path');
const { router, rootRouter } = require('./routes');
const { initWebSocket } = require('./websocket');
const { initDB } = require('./config/database');

const app = new Koa();

// Middleware
app.use(cors());
app.use(bodyParser());
app.use(serve(path.join(__dirname, '../public')));

// Routes
app.use(router.routes());
app.use(router.allowedMethods());
app.use(rootRouter.routes());
app.use(rootRouter.allowedMethods());

const server = http.createServer(app.callback());

const PORT = process.env.PORT || 3001;
const NACOS_ENABLED = process.env.NACOS_ENABLED === 'true';

// ---------------------------------------------------------------------------
// Nacos helpers (only loaded when NACOS_ENABLED=true)
// ---------------------------------------------------------------------------

async function startWithNacos() {
    const { NacosNamingClient, NacosConfigClient } = require('nacos');
    const nacosConfig = require('./config/nacos');

    const configClient = new NacosConfigClient({
        serverAddr: nacosConfig.serverList,
        namespace: nacosConfig.namespace,
    });

    console.log(`Getting config from Nacos: dataId=${nacosConfig.dataId}, group=${nacosConfig.group}`);
    const content = await configClient.getConfig(nacosConfig.dataId, nacosConfig.group);
    console.log('Raw config from Nacos:', content);

    if (!content) {
        throw new Error('Failed to get config from Nacos, content is empty.');
    }

    const dbConfig = JSON.parse(content);

    if (dbConfig.DEFAULT_DIR) {
        process.env.DEFAULT_DIR = dbConfig.DEFAULT_DIR;
    }

    await initDB(dbConfig);
    console.log('Database initialized (via Nacos)');

    const namingClient = new NacosNamingClient({
        logger: console,
        serverList: nacosConfig.serverList,
        namespace: nacosConfig.namespace,
    });
    await namingClient.ready();

    await namingClient.registerInstance(nacosConfig.serviceName, {
        ip: '127.0.0.1',
        port: PORT,
    });
    console.log('Service registered to Nacos');

    return { namingClient, userCenterServiceName: nacosConfig.userCenterServiceName };
}

// ---------------------------------------------------------------------------
// Local / .env fallback
// ---------------------------------------------------------------------------

async function startWithEnv() {
    const dbConfig = {
        DB_HOST: process.env.DB_HOST || 'localhost',
        DB_USER: process.env.DB_USER || 'admin_user',
        DB_PASSWORD: process.env.DB_PASSWORD || 'admin_password',
        DB_NAME: process.env.DB_NAME || 'admin_db',
        DB_PORT: process.env.DB_PORT || 3306,
    };

    await initDB(dbConfig);
    console.log('Database initialized (via .env)');
    return { namingClient: null, userCenterServiceName: null };
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function startServer() {
    try {
        let namingClient = null;
        let userCenterServiceName = null;

        if (NACOS_ENABLED) {
            try {
                const nacos = await startWithNacos();
                namingClient = nacos.namingClient;
                userCenterServiceName = nacos.userCenterServiceName;
            } catch (err) {
                console.warn('Nacos unavailable, falling back to .env config:', err.message);
                await startWithEnv();
            }
        } else {
            await startWithEnv();
        }

        initWebSocket(server, namingClient, userCenterServiceName);

        server.listen(PORT, () => {
            console.log(`Admin backend listening on port ${PORT}`);
        });
    } catch (error) {
        console.error('Failed to start server', error);
        process.exit(1);
    }
}

startServer();

