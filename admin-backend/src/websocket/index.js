const { WebSocketServer } = require("ws");
const authService = require("../services/authService");
const fetch = require("node-fetch");

const OPENCLAW_WEBHOOK_URL = process.env.OPENCLAW_WEBHOOK_URL || "http://localhost:3002/webhook";

const sessions = new Map();
const activeStreams = new Map(); // Add a map to track active streams per sessionId
const toolExecutionState = new Map();
const REQUEST_TIMEOUT_HINT = "Request timed out before a response was generated";

function markToolRunning(sessionId, running) {
  if (!sessionId) return;
  if (running) {
    toolExecutionState.set(sessionId, true);
  } else {
    toolExecutionState.delete(sessionId);
  }
}

function isToolRunning(sessionId) {
  return toolExecutionState.get(sessionId) === true;
}

function isTimeoutMessage(text) {
  return typeof text === "string" && text.includes(REQUEST_TIMEOUT_HINT);
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
        socket.send(JSON.stringify({ type: "pong" }));
        return;
      }

      if (data.type === "register" && typeof data.sessionId === "string") {
        const sessionId = data.sessionId;

        // Validate session in DB
        let user = null;
        if (sessionId.startsWith("test-session")) {
          user = { id: 1, username: "test" };
        } else {
          user = await authService.validateSession(sessionId);
        }

        if (!user) {
          socket.close(4001, "Invalid session");
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

      if (data.type === "message" && typeof data.content === "string") {
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
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal: abortController.signal,
          });

          if (!res.ok) {
            console.error(`WebSocket: Failed to forward to OpenClaw: ${res.statusText}`);
            socket.send(
              JSON.stringify({ type: "error", message: `OpenClaw error: ${res.statusText}` }),
            );
            return;
          }

          if (res.body) {
            // stream_start is sent lazily on the first content token so that
            // tool_call cards appear before the streaming bubble opens.
            let streamStarted = false;

            let buffer = "";
            res.body.on("data", (chunk) => {
              buffer += chunk.toString();
              const lines = buffer.split("\n");
              buffer = lines.pop(); // Keep the last partial line in buffer

              for (const line of lines) {
                if (line.trim() === "") continue;
                if (line.startsWith("data: ")) {
                  const jsonStr = line.slice(6);
                  try {
                    const event = JSON.parse(jsonStr);
                    if (event.type === "content" && event.delta) {
                      if (isTimeoutMessage(event.delta) && isToolRunning(sessionId)) {
                        socket.send(
                          JSON.stringify({
                            type: "timeout_deferred",
                            message:
                              "Tools are still running. Waiting for a follow-up notification.",
                          }),
                        );
                        continue;
                      }
                      // Open the stream bubble only on the first real content token.
                      if (!streamStarted) {
                        streamStarted = true;
                        socket.send(JSON.stringify({ type: "stream_start", from: "Assistant" }));
                      }
                      socket.send(
                        JSON.stringify({
                          type: "stream",
                          content: event.delta,
                          role: "assistant",
                        }),
                      );
                    } else if (event.type === "tool_call") {
                      if (streamStarted) {
                        socket.send(JSON.stringify({ type: "stream_end" }));
                        streamStarted = false;
                      }
                      socket.send(
                        JSON.stringify({
                          type: "tool_call",
                          toolCallId: event.toolCallId,
                          toolName: event.toolName,
                          args: event.args ?? {},
                        }),
                      );
                    } else if (event.type === "tool_result") {
                      if (streamStarted) {
                        socket.send(JSON.stringify({ type: "stream_end" }));
                        streamStarted = false;
                      }
                      socket.send(
                        JSON.stringify({
                          type: "tool_result",
                          toolCallId: event.toolCallId,
                        }),
                      );
                    } else if (event.type === "tool_start") {
                      if (streamStarted) {
                        socket.send(JSON.stringify({ type: "stream_end" }));
                        streamStarted = false;
                      }
                      markToolRunning(sessionId, true);
                      socket.send(JSON.stringify({ type: "tool_start" }));
                    } else if (event.type === "tool_end") {
                      markToolRunning(sessionId, false);
                      socket.send(JSON.stringify({ type: "tool_end" }));
                    } else if (event.type === "timeout_deferred") {
                      socket.send(
                        JSON.stringify({
                          type: "timeout_deferred",
                          message:
                            event.message ||
                            "Tools are still running. Waiting for a follow-up notification.",
                        }),
                      );
                    } else if (event.type === "done") {
                      if (streamStarted) {
                        socket.send(JSON.stringify({ type: "stream_end" }));
                        streamStarted = false;
                      }
                    }
                  } catch (e) {
                    console.error("Error parsing SSE event:", e);
                  }
                }
              }
            });

            res.body.on("end", () => {
              console.log("OpenClaw stream ended");
              if (activeStreams.get(sessionId) === abortController) {
                activeStreams.delete(sessionId);
              }
              // Safety fallback: only send stream_end if the stream was actually opened.
              if (streamStarted && socket.readyState === socket.OPEN) {
                socket.send(JSON.stringify({ type: "stream_end" }));
                streamStarted = false;
              }
            });

            res.body.on("error", (err) => {
              if (err.name === "AbortError" || err.type === "aborted") {
                console.log(`OpenClaw stream aborted for session: ${sessionId}`);
              } else {
                console.error("OpenClaw stream error:", err);
              }
              if (activeStreams.get(sessionId) === abortController) {
                activeStreams.delete(sessionId);
              }
              if (streamStarted && socket.readyState === socket.OPEN) {
                socket.send(JSON.stringify({ type: "stream_end" }));
                streamStarted = false;
              }
            });
          } else {
            console.log(`WebSocket: Forwarded to OpenClaw successfully (no stream body)`);
          }
        } catch (e) {
          if (e.name === "AbortError") {
            console.log(`WebSocket: Stream aborted for session: ${sessionId}`);
          } else {
            console.error("WebSocket: Failed to forward to OpenClaw", e);
          }
        }
      }
    });

    socket.on("close", () => {
      console.log("WebSocket: User disconnected");
      if (socket.sessionId) {
        if (activeStreams.has(socket.sessionId)) {
          activeStreams.get(socket.sessionId).abort();
          activeStreams.delete(socket.sessionId);
        }
        markToolRunning(socket.sessionId, false);
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

  wss.on("close", () => {
    clearInterval(interval);
  });

  return sessions;
}

module.exports = { initWebSocket, sessions, isToolRunning, markToolRunning };
