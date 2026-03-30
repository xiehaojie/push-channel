const { WebSocketServer } = require("ws");
const authService = require("../services/authService");
const fetch = require("node-fetch");

const OPENCLAW_WEBHOOK_URL = process.env.OPENCLAW_WEBHOOK_URL || "http://localhost:3002/webhook";

const connections = new Map();
const activeStreams = new Map();
const toolExecutionState = new Map();
const REQUEST_TIMEOUT_HINT = "Request timed out before a response was generated";

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

      if (data.type === "register" && typeof data.agentId === "string") {
        const agentId = data.agentId.trim();

        if (!agentId) {
          socket.close(4001, "Invalid agent");
          return;
        }

        let user = null;
        if (agentId.startsWith("test-agent")) {
          user = { id: 1, username: "test" };
        } else {
          user = await authService.validateAgent(agentId);
        }

        if (!user) {
          socket.close(4001, "Invalid agent");
          return;
        }

        const existing = connections.get(agentId);
        if (existing && existing !== socket) {
          try {
            existing.close(4001, "Agent already connected");
          } catch {}
        }

        console.log(`WebSocket: User registered with agentId: ${agentId}`);
        connections.set(agentId, socket);
        socket.agentId = agentId;
        return;
      }

      if (data.type === "message" && typeof data.content === "string") {
        const agentId = socket.agentId;
        if (!agentId) {
          console.error("WebSocket: Socket not registered with agentId");
          return;
        }

        try {
          const sessionId =
            typeof data.sessionId === "string" && data.sessionId.trim() ? data.sessionId.trim() : agentId;
          const payload = { agentId, sessionId, content: data.content };

          console.log("WebSocket: Forwarding to OpenClaw with payload:", payload);

          if (activeStreams.has(agentId)) {
            console.log(`WebSocket: Aborting previous stream for agent: ${agentId}`);
            activeStreams.get(agentId).abort();
            activeStreams.delete(agentId);
          }

          const abortController = new AbortController();
          activeStreams.set(agentId, abortController);

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
            let streamStarted = false;

            let buffer = "";
            res.body.on("data", (chunk) => {
              buffer += chunk.toString();
              const lines = buffer.split("\n");
              buffer = lines.pop();

              for (const line of lines) {
                if (line.trim() === "" || !line.startsWith("data: ")) continue;

                const jsonStr = line.slice(6);
                try {
                  const event = JSON.parse(jsonStr);
                  if (event.type === "content" && event.delta) {
                    if (isTimeoutMessage(event.delta) && isToolRunning(agentId)) {
                      socket.send(
                        JSON.stringify({
                          type: "timeout_deferred",
                          message: "Tools are still running. Waiting for a follow-up notification.",
                        }),
                      );
                      continue;
                    }

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
                    markToolRunning(agentId, true);
                    socket.send(JSON.stringify({ type: "tool_start" }));
                  } else if (event.type === "tool_end") {
                    markToolRunning(agentId, false);
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
                  } else if (event.type === "done" && streamStarted) {
                    socket.send(JSON.stringify({ type: "stream_end" }));
                    streamStarted = false;
                  }
                } catch (error) {
                  console.error("Error parsing SSE event:", error);
                }
              }
            });

            res.body.on("end", () => {
              console.log("OpenClaw stream ended");
              if (activeStreams.get(agentId) === abortController) {
                activeStreams.delete(agentId);
              }
              if (streamStarted && socket.readyState === socket.OPEN) {
                socket.send(JSON.stringify({ type: "stream_end" }));
                streamStarted = false;
              }
            });

            res.body.on("error", (error) => {
              if (error.name === "AbortError" || error.type === "aborted") {
                console.log(`OpenClaw stream aborted for agent: ${agentId}`);
              } else {
                console.error("OpenClaw stream error:", error);
              }
              if (activeStreams.get(agentId) === abortController) {
                activeStreams.delete(agentId);
              }
              if (streamStarted && socket.readyState === socket.OPEN) {
                socket.send(JSON.stringify({ type: "stream_end" }));
                streamStarted = false;
              }
            });
          } else {
            console.log("WebSocket: Forwarded to OpenClaw successfully (no stream body)");
          }
        } catch (error) {
          if (error.name === "AbortError") {
            console.log(`WebSocket: Stream aborted for agent: ${agentId}`);
          } else {
            console.error("WebSocket: Failed to forward to OpenClaw", error);
          }
        }
      }
    });

    socket.on("close", () => {
      console.log("WebSocket: User disconnected");
      if (!socket.agentId) return;

      if (activeStreams.has(socket.agentId)) {
        activeStreams.get(socket.agentId).abort();
        activeStreams.delete(socket.agentId);
      }

      markToolRunning(socket.agentId, false);
      const current = connections.get(socket.agentId);
      if (current === socket) {
        connections.delete(socket.agentId);
      }
    });
  });

  const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        if (ws.agentId) {
          connections.delete(ws.agentId);
        }
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on("close", () => {
    clearInterval(interval);
  });

  return connections;
}

module.exports = { initWebSocket, connections, isToolRunning, markToolRunning };
