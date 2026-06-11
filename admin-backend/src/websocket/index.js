const { WebSocketServer } = require("ws");
const fetch = require("node-fetch");

const REQUEST_TIMEOUT_HINT = "Request timed out before a response was generated";
const CUMULATIVE_PREFIX_LEN = 80;
const CUMULATIVE_MIN_LEN = 200;
const MAX_CUMULATIVE_TRACKERS = 500;

const connections = new Map();
const activeStreams = new Map();
const requestQueues = new Map();
const toolExecutionState = new Map();
const streamContexts = new Map();
const agentMessageCount = new Map();

function getOpenClawWebhookUrl() {
  return process.env.OPENCLAW_WEBHOOK_URL || "http://localhost:3002/webhook";
}

function trimToNull(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeMentions(value) {
  if (!Array.isArray(value)) return undefined;
  const mentions = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const agentId = trimToNull(item.agentId);
    if (!agentId) continue;
    const mention = { agentId };
    const label = trimToNull(item.label);
    if (label) mention.label = label;
    mentions.push(mention);
  }
  return mentions.length > 0 ? mentions : undefined;
}

function socketIsOpen(socket) {
  return socket.readyState === socket.OPEN;
}

function sendJson(socket, payload) {
  if (!socketIsOpen(socket)) return;
  socket.send(JSON.stringify(payload));
}

function broadcast(agentId, payload, excludeSocket = null, sessionId = null) {
  const sockets = connections.get(agentId);
  if (!sockets || sockets.size === 0) return;

  const message = typeof payload === "string" ? payload : JSON.stringify(payload);
  for (const socket of sockets) {
    if (socket === excludeSocket || !socketIsOpen(socket)) continue;
    if (sessionId && !socket.sessionIds?.has(sessionId)) continue;
    socket.send(message);
  }
}

function broadcastToSession(agentId, sessionId, payload, excludeSocket = null) {
  broadcast(agentId, payload, excludeSocket, trimToNull(sessionId));
}

function addConnection(agentId, socket) {
  const sockets = connections.get(agentId) || new Set();
  sockets.add(socket);
  connections.set(agentId, sockets);
}

function subscribeSocketToSession(socket, sessionId) {
  const normalized = trimToNull(sessionId);
  if (!normalized) return;
  if (!socket.sessionIds) socket.sessionIds = new Set();
  socket.sessionIds.add(normalized);
}

function removeConnection(agentId, socket) {
  const sockets = connections.get(agentId);
  if (!sockets) return;
  sockets.delete(socket);
  if (sockets.size === 0) {
    connections.delete(agentId);
    agentMessageCount.delete(agentId);
    toolExecutionState.delete(agentId);
    for (const key of streamContexts.keys()) {
      if (key.startsWith(`${agentId}:`)) streamContexts.delete(key);
    }
    abortStreamsByPrefix(`${agentId}:`);
  }
}

function markToolRunning(agentId, running) {
  if (!agentId) return;
  if (running) {
    toolExecutionState.set(agentId, true);
  } else {
    toolExecutionState.delete(agentId);
  }
}

function isToolRunning(agentId) {
  return toolExecutionState.get(agentId) === true;
}

function isTimeoutMessage(text) {
  return typeof text === "string" && text.includes(REQUEST_TIMEOUT_HINT);
}

function nextMessageSeq(agentId) {
  const next = (agentMessageCount.get(agentId) || 0) + 1;
  agentMessageCount.set(agentId, next);
  return next;
}

function createStreamContext(agentId, sessionId, queryMessageId, baseAnswerMessageId) {
  return {
    agentId,
    sessionId,
    queryMessageId,
    baseAnswerMessageId,
    currentAnswerMessageId: null,
    streamPartIndex: 0,
    streamStarted: false,
    streamEnded: false,
    cumulativeTrackers: new Map(),
  };
}

function setMessageIds(context, queryMessageId, baseAnswerMessageId) {
  if (queryMessageId) context.queryMessageId = queryMessageId;
  if (baseAnswerMessageId && baseAnswerMessageId !== context.baseAnswerMessageId) {
    context.baseAnswerMessageId = baseAnswerMessageId;
    context.currentAnswerMessageId = null;
    context.streamPartIndex = 0;
  }
}

function appendMessageIds(payload, context) {
  if (context.queryMessageId) payload.queryMessageId = context.queryMessageId;
  if (context.currentAnswerMessageId) {
    payload.answerMessageId = context.currentAnswerMessageId;
  }
  return payload;
}

function startNewStreamPart(context) {
  if (!context.baseAnswerMessageId) return;
  context.streamPartIndex += 1;
  context.currentAnswerMessageId = `${context.baseAnswerMessageId}-${context.streamPartIndex}`;
}

function createStreamStart(context) {
  startNewStreamPart(context);
  const payload = { type: "stream_start", from: "Assistant" };
  if (context.sessionId) payload.sessionId = context.sessionId;
  return appendMessageIds(payload, context);
}

function createStreamEnd(context) {
  const payload = { type: "stream_end" };
  if (context.sessionId) payload.sessionId = context.sessionId;
  return appendMessageIds(payload, context);
}

function getStreamContext(agentId, sessionId, queryMessageId, baseAnswerMessageId) {
  const key = `${agentId}:${sessionId || agentId}`;
  let context = streamContexts.get(key);
  if (!context) {
    context = createStreamContext(agentId, sessionId, queryMessageId, baseAnswerMessageId);
    streamContexts.set(key, context);
  } else {
    setMessageIds(context, queryMessageId, baseAnswerMessageId);
  }
  return { key, context };
}

function closeStartedStream(context, messages) {
  if (!context.streamStarted) return;
  messages.push(createStreamEnd(context));
  context.streamStarted = false;
}

function ensureStreamStarted(context, messages) {
  if (context.streamStarted) return;
  messages.push(createStreamStart(context));
  context.streamStarted = true;
  context.streamEnded = false;
}

function processContentDelta(event, context, running, messages) {
  const delta = event.delta;
  if (typeof delta !== "string") return;

  if (isTimeoutMessage(delta) && running) {
    const payload = {
      type: "timeout_deferred",
      message: "Tools are still running. Waiting for a follow-up notification.",
    };
    if (context.sessionId) payload.sessionId = context.sessionId;
    messages.push(appendMessageIds(payload, context));
    return;
  }

  if (delta.length >= CUMULATIVE_MIN_LEN) {
    const fingerprint = delta.slice(0, Math.min(CUMULATIVE_PREFIX_LEN, delta.length));
    const lastFull = context.cumulativeTrackers.get(fingerprint);

    if (lastFull) {
      if (delta.length > lastFull.length && delta.startsWith(lastFull)) {
        context.cumulativeTrackers.set(fingerprint, delta);
      }
      return;
    }

    if (context.cumulativeTrackers.size >= MAX_CUMULATIVE_TRACKERS) {
      context.cumulativeTrackers.clear();
    }
    context.cumulativeTrackers.set(fingerprint, delta);
    ensureStreamStarted(context, messages);

    const payload = { type: "stream_snapshot", snapshot: delta, role: "assistant" };
    if (context.sessionId) payload.sessionId = context.sessionId;
    messages.push(appendMessageIds(payload, context));
    return;
  }

  ensureStreamStarted(context, messages);
  const payload = { type: "stream", content: delta, role: "assistant" };
  if (context.sessionId) payload.sessionId = context.sessionId;
  messages.push(appendMessageIds(payload, context));
}

function processSSEEvent(agentId, line, sessionId, queryMessageId, baseAnswerMessageId) {
  const messages = [];
  if (typeof line !== "string" || line.trim() === "" || !line.startsWith("data: ")) {
    return { messages, closeContext: false };
  }

  const { key, context } = getStreamContext(agentId, sessionId, queryMessageId, baseAnswerMessageId);
  let event;
  try {
    event = JSON.parse(line.slice(6));
  } catch (error) {
    console.error("Error parsing SSE event:", error);
    return { messages, closeContext: false };
  }

  if (event.type === "content") {
    processContentDelta(event, context, isToolRunning(agentId), messages);
  } else if (event.type === "tool_call") {
    closeStartedStream(context, messages);
    const payload = {
      type: "tool_call",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: event.args ?? {},
    };
    if (context.sessionId) payload.sessionId = context.sessionId;
    messages.push(appendMessageIds(payload, context));
  } else if (event.type === "tool_result") {
    closeStartedStream(context, messages);
    const payload = { type: "tool_result", toolCallId: event.toolCallId };
    if (event.toolName) payload.toolName = event.toolName;
    if (event.content !== undefined) payload.content = event.content;
    if (event.isError !== undefined) payload.isError = event.isError;
    if (context.sessionId) payload.sessionId = context.sessionId;
    messages.push(appendMessageIds(payload, context));
  } else if (event.type === "tool_start") {
    closeStartedStream(context, messages);
    markToolRunning(agentId, true);
    const payload = { type: "tool_start" };
    if (context.sessionId) payload.sessionId = context.sessionId;
    messages.push(appendMessageIds(payload, context));
  } else if (event.type === "tool_end") {
    markToolRunning(agentId, false);
    const payload = { type: "tool_end" };
    if (context.sessionId) payload.sessionId = context.sessionId;
    messages.push(appendMessageIds(payload, context));
  } else if (event.type === "timeout_deferred") {
    const payload = {
      type: "timeout_deferred",
      message: event.message || "Tools are still running. Waiting for a follow-up notification.",
    };
    if (context.sessionId) payload.sessionId = context.sessionId;
    messages.push(appendMessageIds(payload, context));
  } else if (
    event.type === "subagent_start" ||
    event.type === "subagent_stream" ||
    event.type === "subagent_result" ||
    event.type === "subagent_error" ||
    event.type === "subagent_end"
  ) {
    closeStartedStream(context, messages);
    const payload = { type: event.type };
    const subagentId = trimToNull(event.agentId);
    if (subagentId) payload.agentId = subagentId;
    const label = trimToNull(event.label);
    if (label) payload.label = label;
    if (typeof event.content === "string") payload.content = event.content;
    if (typeof event.message === "string") payload.message = event.message;
    const status = trimToNull(event.status);
    if (status) payload.status = status;
    if (context.sessionId) payload.sessionId = context.sessionId;
    messages.push(appendMessageIds(payload, context));
  } else if (event.type === "done") {
    closeStartedStream(context, messages);
    context.streamEnded = true;
    streamContexts.delete(key);
    return { messages, closeContext: true };
  }

  return { messages, closeContext: false };
}

function flushStreamContext(agentId, sessionId) {
  const key = `${agentId}:${sessionId || agentId}`;
  const context = streamContexts.get(key);
  if (!context || !context.streamStarted || context.streamEnded) return [];
  const messages = [createStreamEnd(context)];
  context.streamStarted = false;
  context.streamEnded = true;
  streamContexts.delete(key);
  return messages;
}

function abortStreamsByPrefix(prefix) {
  for (const [requestKey, controller] of activeStreams.entries()) {
    if (!requestKey.startsWith(prefix)) continue;
    controller.abort();
    activeStreams.delete(requestKey);
  }
}

function queueForwardMessage(socket, data) {
  const agentId = socket.agentId;
  const content = typeof data.content === "string" ? data.content : "";
  if (!agentId || !content) return Promise.resolve();

  const sessionId = trimToNull(data.sessionId) || agentId;
  const requestKey = `${agentId}:${sessionId}`;
  const previous = requestQueues.get(requestKey) || Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(() => {
      if (!socketIsOpen(socket)) return;
      return forwardMessage(socket, data);
    });

  requestQueues.set(requestKey, current);
  current.finally(() => {
    if (requestQueues.get(requestKey) === current) {
      requestQueues.delete(requestKey);
    }
  });

  return current;
}

async function forwardMessage(socket, data) {
  const agentId = socket.agentId;
  if (!agentId) {
    console.error("WebSocket: Socket not registered with agentId");
    return;
  }

  const content = typeof data.content === "string" ? data.content : "";
  if (!content) return;

  const sessionId = trimToNull(data.sessionId) || agentId;
  const queryMessageId = trimToNull(data.queryMessageId);
  const baseAnswerMessageId = trimToNull(data.answerMessageId);
  const requestKey = `${agentId}:${sessionId}`;

  const sentMessage = { type: "message_sent", content, role: "user", sessionId };
  if (queryMessageId) sentMessage.queryMessageId = queryMessageId;
  if (baseAnswerMessageId) sentMessage.answerMessageId = baseAnswerMessageId;
  sendJson(socket, sentMessage);
  subscribeSocketToSession(socket, sessionId);
  broadcastToSession(agentId, sessionId, sentMessage, socket);

  const abortController = new AbortController();
  activeStreams.set(requestKey, abortController);
  const payload = { agentId, sessionId, content };
  const mentions = normalizeMentions(data.mentions);
  if (mentions) payload.mentions = mentions;

  try {
    console.log("WebSocket: Forwarding to OpenClaw with payload:", payload);
    const res = await fetch(getOpenClawWebhookUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: abortController.signal,
    });

    if (!res.ok) {
      const message = `OpenClaw error: ${res.statusText || res.status}`;
      console.error(`WebSocket: Failed to forward to OpenClaw: ${message}`);
      broadcastToSession(agentId, sessionId, { type: "error", message, sessionId });
      return;
    }

    if (!res.body) {
      console.log("WebSocket: Forwarded to OpenClaw successfully (no stream body)");
      return;
    }

    let buffer = "";
    res.body.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        const result = processSSEEvent(agentId, line, sessionId, queryMessageId, baseAnswerMessageId);
        for (const message of result.messages) {
          broadcastToSession(agentId, sessionId, message);
        }
      }
    });

    res.body.on("end", () => {
      console.log("OpenClaw stream ended");
      if (activeStreams.get(requestKey) === abortController) {
        activeStreams.delete(requestKey);
      }
      for (const message of flushStreamContext(agentId, sessionId)) {
        broadcastToSession(agentId, sessionId, message);
      }
    });

    res.body.on("error", (error) => {
      if (error.name === "AbortError" || error.type === "aborted") {
        console.log(`OpenClaw stream aborted for request: ${requestKey}`);
      } else {
        console.error("OpenClaw stream error:", error);
      }
      if (activeStreams.get(requestKey) === abortController) {
        activeStreams.delete(requestKey);
      }
      for (const message of flushStreamContext(agentId, sessionId)) {
        broadcastToSession(agentId, sessionId, message);
      }
    });
  } catch (error) {
    if (error.name === "AbortError") {
      console.log(`WebSocket: Stream aborted for request: ${requestKey}`);
    } else {
      console.error("WebSocket: Failed to forward to OpenClaw", error);
      broadcastToSession(agentId, sessionId, {
        type: "error",
        message: `Failed to connect to OpenClaw: ${error.message}`,
        sessionId,
      });
    }
    if (activeStreams.get(requestKey) === abortController) {
      activeStreams.delete(requestKey);
    }
  }
}

function initWebSocket(server) {
  const wss = new WebSocketServer({ server });

  wss.on("connection", (socket) => {
    console.log("WebSocket: A user connected");

    socket.isAlive = true;
    socket.on("pong", () => {
      socket.isAlive = true;
    });

    socket.on("message", async (raw) => {
      let data;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (data.type === "ping") {
        sendJson(socket, { type: "pong" });
        return;
      }

      if (data.type === "register") {
        const agentId = trimToNull(data.agentId);
        if (!agentId) {
          socket.close(4001, "Invalid agentId");
          return;
        }

        socket.agentId = agentId;
        socket.connectedTime = Date.now();
        subscribeSocketToSession(socket, data.sessionId);
        addConnection(agentId, socket);
        nextMessageSeq(agentId);

        console.log(`WebSocket: User registered with agentId: ${agentId}`);
        sendJson(socket, {
          type: "registered",
          agentId,
          files: [],
          path: "",
        });
        return;
      }

      if (data.type === "message") {
        await queueForwardMessage(socket, data);
      }
    });

    socket.on("close", () => {
      console.log("WebSocket: User disconnected");
      if (!socket.agentId) return;
      removeConnection(socket.agentId, socket);
    });
  });

  const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        if (ws.agentId) removeConnection(ws.agentId, ws);
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);
  interval.unref();

  wss.on("close", () => {
    clearInterval(interval);
  });

  return connections;
}

module.exports = {
  initWebSocket,
  connections,
  isToolRunning,
  markToolRunning,
  broadcast,
  broadcastToSession,
};
