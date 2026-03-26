import type { ServerResponse } from "node:http";
import { getPushChannelRuntime } from "./runtime.js";
import { sendPushMessage } from "./send.js";
import { setWriter, clearWriter } from "./tool-store.js";

const REQUEST_TIMEOUT_HINT = "Request timed out before a response was generated";

function isTimeoutFinalReply(text: string): boolean {
  return text.includes(REQUEST_TIMEOUT_HINT);
}

export function createStreamingReplyDispatcher(res: ServerResponse, sessionKey?: string) {
  // Send initial headers
  if (!res.headersSent) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Transfer-Encoding": "chunked",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();
  }

  // Track whether any tokens were streamed via onPartialReply to avoid
  // duplicating content when sendBlockReply/sendFinalReply fire afterwards.
  let hasStreamedContent = false;
  // onPartialReply receives cumulative text each call; track previous length
  // so we only emit the new delta characters.
  let previousTextLength = 0;
  let toolExecutionStarted = false;
  let toolExecutionEnded = false;

  const emitToolStart = () => {
    if (res.writableEnded || toolExecutionStarted) {
      return;
    }
    toolExecutionStarted = true;
    res.write(`data: ${JSON.stringify({ type: "tool_start" })}\n\n`);
  };

  const emitToolEnd = () => {
    if (res.writableEnded || !toolExecutionStarted || toolExecutionEnded) {
      return;
    }
    toolExecutionEnded = true;
    res.write(`data: ${JSON.stringify({ type: "tool_end" })}\n\n`);
  };

  // Register a writer so before_tool_call / tool_result_persist hooks can emit
  // tool_call / tool_result events directly into this SSE stream.
  if (sessionKey) {
    setWriter(sessionKey, (event) => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    });
  }

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
    sendToolResult: () => {
      emitToolStart();
      previousTextLength = 0;
      hasStreamedContent = false;
      return true;
    },
    sendBlockReply: (payload: any) => {
      if (res.writableEnded) return false;
      // Skip content if already streamed token-by-token via onPartialReply
      if (!hasStreamedContent) {
        const text = payload.text || payload.content || "";
        if (text) {
          res.write(`data: ${JSON.stringify({ type: "content", delta: text })}\n\n`);
        }
      }
      
      // Reset for the next block
      previousTextLength = 0;
      hasStreamedContent = false;
      
      return true;
    },
    sendFinalReply: (payload: any) => {
      if (res.writableEnded) return false;
      const text = payload.text || payload.content || "";
      const timeoutFinal = typeof text === "string" && isTimeoutFinalReply(text);
      if (timeoutFinal) {
        // Timeout final replies usually mean tool work may still be running.
        // Emit an explicit marker so middleware/frontend can defer timeout UX
        // and keep waiting for follow-up push notifications.
        emitToolStart();
        res.write(
          `data: ${JSON.stringify({ type: "timeout_deferred", message: "Tools are still running. Waiting for a follow-up notification." })}\n\n`,
        );
      } else {
        emitToolEnd();
      }
      // Skip content if already streamed token-by-token via onPartialReply
      if (!hasStreamedContent) {
        if (!timeoutFinal && text) {
          res.write(`data: ${JSON.stringify({ type: "content", delta: text })}\n\n`);
        }
      }
      res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
      res.end();
      if (sessionKey) clearWriter(sessionKey);
      return true;
    },
    waitForIdle: async () => {},
    getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
    markComplete: () => {
      emitToolEnd();
      if (sessionKey) clearWriter(sessionKey);
    },
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
        sendPushMessage(middlewareUrl, sessionId, text).catch((err) => {
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
