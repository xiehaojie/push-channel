require('dotenv').config();
const Koa = require('koa');
const http = require('http');
const bodyParser = require('koa-bodyparser');
const cors = require('@koa/cors');
const { router, rootRouter } = require('./routes');
const { initWebSocket } = require('./websocket');

const app = new Koa();

// Middleware
app.use(cors());
app.use(bodyParser());

// Routes
app.use(router.routes());
app.use(router.allowedMethods());
app.use(rootRouter.routes());
app.use(rootRouter.allowedMethods());

const server = http.createServer(app.callback());

// Initialize WebSocket
initWebSocket(server);

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
    console.log(`Admin backend listening on port ${PORT}`);
});
