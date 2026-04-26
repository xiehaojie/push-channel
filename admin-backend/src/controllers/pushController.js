const { connections } = require('../websocket/index');

class PushController {
    async send(ctx) {
        const body = ctx.request.body;
        console.log(`Received push request:`, JSON.stringify(body));

        const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : '';
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
        const content = body.content;

        if (!agentId || !content) {
            ctx.status = 400;
            ctx.body = "Missing agentId or content";
            return;
        }

        const socketSet = connections.get(agentId);
        if (socketSet && socketSet.size > 0) {
            const chunkSize = 5;
            const delay = 50;

            // 广播到该 agentId 的所有连接
            const broadcast = (msg) => {
                const msgStr = JSON.stringify(msg);
                for (const sock of socketSet) {
                    if (sock.readyState === 1) { // WebSocket.OPEN
                        sock.send(msgStr);
                    }
                }
            };

            const streamLoop = async () => {
                broadcast({ type: "stream_start", from: 'Assistant', sessionId });

                let currentIndex = 0;
                while (currentIndex < content.length) {
                    const chunk = content.slice(currentIndex, currentIndex + chunkSize);
                    broadcast({ type: "stream", content: chunk, role: 'assistant', sessionId });
                    currentIndex += chunkSize;
                    await new Promise(r => setTimeout(r, delay));
                }
                broadcast({ type: "stream_end", sessionId });
            };
            
            streamLoop().catch(err => console.error("Streaming failed", err));

            ctx.status = 200;
            ctx.body = "Sent";
        } else {
            console.log(`Agent ${agentId} not found or no active connections`);
            ctx.status = 404;
            ctx.body = "Agent not found";
        }
    }
}

module.exports = new PushController();
