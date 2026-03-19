const { sessions } = require('../websocket/index');

class PushController {
    async send(ctx) {
        // OpenClaw SDK might send sessionId in the target, which maps to `sessionId` here.
        // It's passing { sessionId, content } to the middlewareUrl/send
        const body = ctx.request.body;
        // In case OpenClaw sends an array or different structure, let's log it deeply.
        console.log(`Received push request:`, JSON.stringify(body));

        let sessionId = body.sessionId;
        let content = body.content;
        
        // Sometimes content might be wrapped differently depending on how OpenClaw formats message.content.text
        if (!sessionId || !content) {
            ctx.status = 400;
            ctx.body = "Missing sessionId or content";
            return;
        }

        const socket = sessions.get(sessionId);
        if (socket) {
            const chunkSize = 5;
            const delay = 50;

            const streamLoop = async () => {
                socket.send(JSON.stringify({ type: "stream_start", from: 'Assistant' }));

                let currentIndex = 0;
                while (currentIndex < content.length) {
                    const chunk = content.slice(currentIndex, currentIndex + chunkSize);
                    socket.send(JSON.stringify({ type: "stream", content: chunk, role: 'assistant' }));
                    currentIndex += chunkSize;
                    await new Promise(r => setTimeout(r, delay));
                }
                socket.send(JSON.stringify({ type: "stream_end" }));
            };
            
            streamLoop().catch(err => console.error("Streaming failed", err));

            ctx.status = 200;
            ctx.body = "Sent";
        } else {
            console.log(`Session ${sessionId} not found`);
            ctx.status = 404;
            ctx.body = "Session not found";
        }
    }
}

module.exports = new PushController();
