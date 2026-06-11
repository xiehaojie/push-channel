class PushChannelSDK {
  constructor(url, agentId, options = {}) {
    this.url = url;
    this.agentId = agentId;
    this.sessionId = options.sessionId || "";
    this.socket = null;
    this.callbacks = {
      message: null,
      messageSent: null,
      registered: null,
      streamStart: null,
      streamChunk: null,
      streamSnapshot: null,
      streamEnd: null,
      toolStart: null,
      toolEnd: null,
      toolCall: null,
      toolResult: null,
      subagentStart: null,
      subagentStream: null,
      subagentResult: null,
      subagentError: null,
      subagentEnd: null,
      timeoutDeferred: null,
      error: null,
      close: null,
    };
    this.pingInterval = null;
  }

  connect() {
    const wsUrl = this._toWebSocketUrl(this.url);
    this.socket = new WebSocket(wsUrl);

    this.socket.onopen = () => {
      console.log("Connected to server");
      this.socket.send(
        JSON.stringify({
          type: "register",
          agentId: this.agentId,
          sessionId: this.sessionId,
        }),
      );

      this.pingInterval = setInterval(() => {
        if (this.socket.readyState === WebSocket.OPEN) {
          this.socket.send(JSON.stringify({ type: "ping" }));
        }
      }, 30000);
    };

    this.socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === "pong") {
          return;
        }

        if (data.type === "registered" && this.callbacks.registered) {
          this.callbacks.registered(data);
        } else if (data.type === "message_sent" && this.callbacks.messageSent) {
          this.callbacks.messageSent(data);
        } else if (data.type === "stream_start" && this.callbacks.streamStart) {
          this.callbacks.streamStart(data);
        } else if (data.type === "stream" && this.callbacks.streamChunk) {
          this.callbacks.streamChunk(data);
        } else if (data.type === "stream_snapshot" && this.callbacks.streamSnapshot) {
          this.callbacks.streamSnapshot(data);
        } else if (data.type === "stream_end" && this.callbacks.streamEnd) {
          this.callbacks.streamEnd(data);
        } else if (data.type === "tool_call" && this.callbacks.toolCall) {
          this.callbacks.toolCall(data);
        } else if (data.type === "tool_result" && this.callbacks.toolResult) {
          this.callbacks.toolResult(data);
        } else if (data.type === "tool_start" && this.callbacks.toolStart) {
          this.callbacks.toolStart(data);
        } else if (data.type === "tool_end" && this.callbacks.toolEnd) {
          this.callbacks.toolEnd(data);
        } else if (data.type === "subagent_start" && this.callbacks.subagentStart) {
          this.callbacks.subagentStart(data);
        } else if (data.type === "subagent_stream" && this.callbacks.subagentStream) {
          this.callbacks.subagentStream(data);
        } else if (data.type === "subagent_result" && this.callbacks.subagentResult) {
          this.callbacks.subagentResult(data);
        } else if (data.type === "subagent_error" && this.callbacks.subagentError) {
          this.callbacks.subagentError(data);
        } else if (data.type === "subagent_end" && this.callbacks.subagentEnd) {
          this.callbacks.subagentEnd(data);
        } else if (data.type === "timeout_deferred" && this.callbacks.timeoutDeferred) {
          this.callbacks.timeoutDeferred(data);
        } else if (data.type === "message" && this.callbacks.message) {
          this.callbacks.message(data);
        } else if (data.type === "error" && this.callbacks.error) {
          this.callbacks.error(data);
        } else if (data.type === "done" && this.callbacks.streamEnd) {
          this.callbacks.streamEnd(data);
        }
      } catch (err) {
        console.error("Error parsing message", err);
      }
    };

    this.socket.onerror = (error) => {
      console.error("WebSocket error:", error);
      if (this.callbacks.error) this.callbacks.error(error);
    };

    this.socket.onclose = () => {
      console.log("Disconnected from server");
      if (this.pingInterval) clearInterval(this.pingInterval);
      if (this.callbacks.close) this.callbacks.close();
    };
  }

  sendMessage(content, sessionId, metadata = {}) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      const payload = { type: "message", content, ...metadata };
      if (sessionId) {
        payload.sessionId = sessionId;
      }
      this.socket.send(JSON.stringify(payload));
    } else {
      console.error("Socket is not open");
    }
  }

  disconnect() {
    if (this.socket) {
      this.socket.close();
    }
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }
  }

  onMessage(callback) {
    this.callbacks.message = callback;
  }

  onMessageSent(callback) {
    this.callbacks.messageSent = callback;
  }

  onRegistered(callback) {
    this.callbacks.registered = callback;
  }

  onStreamStart(callback) {
    this.callbacks.streamStart = callback;
  }

  onStreamChunk(callback) {
    this.callbacks.streamChunk = callback;
  }

  onStreamSnapshot(callback) {
    this.callbacks.streamSnapshot = callback;
  }

  onStreamEnd(callback) {
    this.callbacks.streamEnd = callback;
  }

  onToolStart(callback) {
    this.callbacks.toolStart = callback;
  }

  onToolEnd(callback) {
    this.callbacks.toolEnd = callback;
  }

  onToolCall(callback) {
    this.callbacks.toolCall = callback;
  }

  onToolResult(callback) {
    this.callbacks.toolResult = callback;
  }

  onSubagentStart(callback) {
    this.callbacks.subagentStart = callback;
  }

  onSubagentStream(callback) {
    this.callbacks.subagentStream = callback;
  }

  onSubagentResult(callback) {
    this.callbacks.subagentResult = callback;
  }

  onSubagentError(callback) {
    this.callbacks.subagentError = callback;
  }

  onSubagentEnd(callback) {
    this.callbacks.subagentEnd = callback;
  }

  onTimeoutDeferred(callback) {
    this.callbacks.timeoutDeferred = callback;
  }

  onError(callback) {
    this.callbacks.error = callback;
  }

  onClose(callback) {
    this.callbacks.close = callback;
  }

  _toWebSocketUrl(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "http:") parsed.protocol = "ws:";
      else if (parsed.protocol === "https:") parsed.protocol = "wss:";
      return parsed.toString();
    } catch {
      return url;
    }
  }
}
