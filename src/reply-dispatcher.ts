
import { sendPushMessage } from "./send.js";
import { getPushChannelRuntime } from "./runtime.js";

export function createPushChannelReplyDispatcher(params: {
    middlewareUrl: string;
    sessionId: string;
}) {
    const { middlewareUrl, sessionId } = params;
    const runtime = getPushChannelRuntime();

    return {
        sendToolResult: () => true,
        sendBlockReply: () => true,
        sendFinalReply: (payload: any) => {
            const text = payload.text || payload.content || "";
            if (text) {
                sendPushMessage(middlewareUrl, sessionId, text).catch(err => {
                    runtime.log?.(`Failed to send reply to ${sessionId}: ${err}`);
                });
            }
            return true;
        },
        waitForIdle: async () => {},
        getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
        markComplete: () => {},
    };
}
