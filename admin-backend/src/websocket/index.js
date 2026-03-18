const { WebSocketServer } = require('ws');
const authService = require('../services/authService');
const fetch = require('node-fetch');

const OPENCLAW_WEBHOOK_URL = process.env.OPENCLAW_WEBHOOK_URL || 'http://localhost:3002/webhook';

const sessions = new Map();

function initWebSocket(server) {
    const wss = new WebSocketServer({ server });

    wss.on('connection', (socket) => {
        console.log('WebSocket: A user connected');

        socket.isAlive = true;
        socket.on('pong', () => {
            socket.isAlive = true;
        });

        socket.on('message', async (raw) => {
            let data;
            try {
                data = JSON.parse(raw.toString());
            } catch {
                return;
            }

            if (data.type === 'ping') {
                socket.send(JSON.stringify({ type: 'pong' }));
                return;
            }

            if (data.type === 'register' && typeof data.sessionId === 'string') {
                const sessionId = data.sessionId;
                
                // Validate session in DB
                const user = await authService.validateSession(sessionId);
                if (!user) {
                    socket.close(4001, 'Invalid session');
                    return;
                }

                const existing = sessions.get(sessionId);
                if (existing && existing !== socket) {
                    try {
                        existing.close(4001, "Session already connected");
                    } catch {}
                }
                
                console.log(`WebSocket: User registered with sessionId: ${sessionId}`);
                sessions.set(sessionId, socket);
                socket.sessionId = sessionId;
                return;
            }

            if (data.type === 'message' && typeof data.content === 'string') {
                const sessionId = socket.sessionId;
                if (!sessionId) {
                    console.error("WebSocket: Socket not registered with sessionId");
                    return;
                }

                try {
                    const res = await fetch(OPENCLAW_WEBHOOK_URL, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ sessionId, content: data.content })
                    });
                    
                    if (!res.ok) {
                        console.error(`WebSocket: Failed to forward to OpenClaw: ${res.statusText}`);
                    } else {
                        console.log(`WebSocket: Forwarded to OpenClaw successfully: ${data.content}`);
                    }
                } catch (e) {
                    console.error("WebSocket: Failed to forward to OpenClaw", e);
                }
            }
        });

        socket.on('close', () => {
            console.log('WebSocket: User disconnected');
            if (socket.sessionId) {
                const current = sessions.get(socket.sessionId);
                if (current === socket) {
                    sessions.delete(socket.sessionId);
                }
            }
        });
    });

    // Heartbeat
    const interval = setInterval(() => {
        wss.clients.forEach((ws) => {
            if (ws.isAlive === false) {
                if (ws.sessionId) sessions.delete(ws.sessionId);
                return ws.terminate();
            }
            ws.isAlive = false;
            ws.ping();
        });
    }, 30000);

    wss.on('close', () => {
        clearInterval(interval);
    });

    return sessions;
}

module.exports = { initWebSocket, sessions };
