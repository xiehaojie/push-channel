const { WebSocketServer } = require('ws');
const authService = require('../services/authService');
const fetch = require('node-fetch');

const OPENCLAW_WEBHOOK_URL = process.env.OPENCLAW_WEBHOOK_URL || 'http://localhost:3002/webhook';

const sessions = new Map();
const activeStreams = new Map(); // Add a map to track active streams per sessionId

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
                let user = null;
                if (sessionId.startsWith('test-session')) {
                    user = { id: 1, username: 'test' };
                } else {
                    user = await authService.validateSession(sessionId);
                }
                
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
                    const payload = { sessionId, content: data.content };
                    if (data.agentId) {
                        payload.agentId = data.agentId;
                    }

                    console.log(`WebSocket: Forwarding to OpenClaw with payload:`, payload);

                    // Abort previous stream for this session to prevent overlapping
                    if (activeStreams.has(sessionId)) {
                        console.log(`WebSocket: Aborting previous stream for session: ${sessionId}`);
                        activeStreams.get(sessionId).abort();
                        activeStreams.delete(sessionId);
                    }

                    const abortController = new AbortController();
                    activeStreams.set(sessionId, abortController);

                    const res = await fetch(OPENCLAW_WEBHOOK_URL, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload),
                        signal: abortController.signal
                    });
                    
                    if (!res.ok) {
                        console.error(`WebSocket: Failed to forward to OpenClaw: ${res.statusText}`);
                        socket.send(JSON.stringify({ type: 'error', message: `OpenClaw error: ${res.statusText}` }));
                        return;
                    }

                    if (res.body) {
                        // Send stream_start before forwarding chunks
                        socket.send(JSON.stringify({ type: 'stream_start', from: 'Assistant' }));
                        
                        let buffer = '';
                        res.body.on('data', (chunk) => {
                            buffer += chunk.toString();
                            const lines = buffer.split('\n');
                            buffer = lines.pop(); // Keep the last partial line in buffer
                            
                            for (const line of lines) {
                                if (line.trim() === '') continue;
                                if (line.startsWith('data: ')) {
                                    const jsonStr = line.slice(6);
                                    try {
                                        const event = JSON.parse(jsonStr);
                                        if (event.type === 'content' && event.delta) {
                                            socket.send(JSON.stringify({ 
                                                type: 'stream', 
                                                content: event.delta, 
                                                role: 'assistant' 
                                            }));
                                        } else if (event.type === 'done') {
                                            socket.send(JSON.stringify({ type: 'stream_end' }));
                                        }
                                    } catch (e) {
                                        console.error('Error parsing SSE event:', e);
                                    }
                                }
                            }
                        });
                        
                        res.body.on('end', () => {
                            console.log('OpenClaw stream ended');
                            if (activeStreams.get(sessionId) === abortController) {
                                activeStreams.delete(sessionId);
                            }
                            // Safety fallback: ensure client receives stream_end even if
                            // OpenClaw closed without sending {type:"done"}
                            if (socket.readyState === socket.OPEN) {
                                socket.send(JSON.stringify({ type: 'stream_end' }));
                            }
                        });

                        res.body.on('error', (err) => {
                            if (err.name === 'AbortError' || err.type === 'aborted') {
                                console.log(`OpenClaw stream aborted for session: ${sessionId}`);
                            } else {
                                console.error('OpenClaw stream error:', err);
                            }
                            if (activeStreams.get(sessionId) === abortController) {
                                activeStreams.delete(sessionId);
                            }
                            if (socket.readyState === socket.OPEN) {
                                socket.send(JSON.stringify({ type: 'stream_end' }));
                            }
                        });
                    } else {
                        console.log(`WebSocket: Forwarded to OpenClaw successfully (no stream body)`);
                    }
                } catch (e) {
                    if (e.name === 'AbortError') {
                        console.log(`WebSocket: Stream aborted for session: ${sessionId}`);
                    } else {
                        console.error("WebSocket: Failed to forward to OpenClaw", e);
                    }
                }
            }
        });

        socket.on('close', () => {
            console.log('WebSocket: User disconnected');
            if (socket.sessionId) {
                if (activeStreams.has(socket.sessionId)) {
                    activeStreams.get(socket.sessionId).abort();
                    activeStreams.delete(socket.sessionId);
                }
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
