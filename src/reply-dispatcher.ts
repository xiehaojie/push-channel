
import { sendPushMessage } from "./send.js";
import { getPushChannelRuntime } from "./runtime.js";
import type { ServerResponse } from "node:http";

export function createStreamingReplyDispatcher(res: ServerResponse) {
    // Send initial headers
    if (!res.headersSent) {
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Transfer-Encoding": "chunked",
            "X-Accel-Buffering": "no"
        });
        res.flushHeaders?.();
    }

    // Track whether any tokens were streamed via onPartialReply to avoid
    // duplicating content when sendBlockReply/sendFinalReply fire afterwards.
    let hasStreamedContent = false;
    // onPartialReply receives cumulative text each call; track previous length
    // so we only emit the new delta characters.
    let previousTextLength = 0;

    const onPartialReply = (payload: any) => {
        const fullText = payload.text || "";
        if (!res.writableEnded && fullText.length > previousTextLength) {
            const delta = fullText.slice(previousTextLength);
            previousTextLength = fullText.length;
            hasStreamedContent = true;
            res.write(`data: ${JSON.stringify({ type: "content", delta })}\n\n`);
        }
    };

    const dispatcher = {
        sendToolResult: () => true,
        sendBlockReply: (payload: any) => {
            if (res.writableEnded) return false;
            // Skip content if already streamed token-by-token via onPartialReply
            if (!hasStreamedContent) {
                const text = payload.text || payload.content || "";
                if (text) {
                    res.write(`data: ${JSON.stringify({ type: "content", delta: text })}\n\n`);
                }
            }
            return true;
        },
        sendFinalReply: (payload: any) => {
            if (res.writableEnded) return false;
            // Skip content if already streamed token-by-token via onPartialReply
            if (!hasStreamedContent) {
                const text = payload.text || payload.content || "";
                if (text) {
                    res.write(`data: ${JSON.stringify({ type: "content", delta: text })}\n\n`);
                }
            }
            res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
            res.end();
            return true;
        },
        waitForIdle: async () => {},
        getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
        markComplete: () => {},
    };

    return { dispatcher, onPartialReply };
}

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
                // Fire and forget, but log errors
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
