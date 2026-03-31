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

        const socket = connections.get(agentId);
        if (socket) {
            const chunkSize = 5;
            const delay = 50;

            const streamLoop = async () => {
                socket.send(JSON.stringify({ type: "stream_start", from: 'Assistant', sessionId }));

                let currentIndex = 0;
                while (currentIndex < content.length) {
                    const chunk = content.slice(currentIndex, currentIndex + chunkSize);
                    socket.send(JSON.stringify({ type: "stream", content: chunk, role: 'assistant', sessionId }));
                    currentIndex += chunkSize;
                    await new Promise(r => setTimeout(r, delay));
                }
                socket.send(JSON.stringify({ type: "stream_end", sessionId }));
            };
            
            streamLoop().catch(err => console.error("Streaming failed", err));

            ctx.status = 200;
            ctx.body = "Sent";
        } else {
            console.log(`Agent ${agentId} not found`);
            ctx.status = 404;
            ctx.body = "Agent not found";
        }
    }
}

module.exports = new PushController();
