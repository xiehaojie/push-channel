const { connections, broadcastToSession } = require('../websocket/index');
const streamCounters = new Map();

function nextAnswerMessageId(agentId, sessionId) {
    const key = `${agentId}:${sessionId}`;
    const next = (streamCounters.get(key) || 0) + 1;
    streamCounters.set(key, next);
    return `push-${key}-${next}`;
}

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

        const sockets = connections.get(agentId);
        if (sockets && sockets.size > 0) {
            const chunkSize = 5;
            const delay = 50;
            const answerMessageId = nextAnswerMessageId(agentId, sessionId || agentId);

            const streamLoop = async () => {
                broadcastToSession(agentId, sessionId, {
                    type: "stream_start",
                    from: 'Assistant',
                    sessionId,
                    answerMessageId
                });

                let currentIndex = 0;
                while (currentIndex < content.length) {
                    const chunk = content.slice(currentIndex, currentIndex + chunkSize);
                    broadcastToSession(agentId, sessionId, {
                        type: "stream",
                        content: chunk,
                        role: 'assistant',
                        sessionId,
                        answerMessageId
                    });
                    currentIndex += chunkSize;
                    await new Promise(r => setTimeout(r, delay));
                }
                broadcastToSession(agentId, sessionId, {
                    type: "stream_end",
                    sessionId,
                    answerMessageId
                });
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
