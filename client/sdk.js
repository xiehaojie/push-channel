(() => {
  class PushChannelSDK {
    constructor(opts) {
      this.middlewareUrl = (opts && opts.middlewareUrl) || "http://localhost:3001";
      this.socketUrl = (opts && opts.socketUrl) || this.middlewareUrl;
      this.socket = null;
    }

    setEndpoints(middlewareUrl, socketUrl) {
      this.middlewareUrl = middlewareUrl || this.middlewareUrl;
      this.socketUrl = socketUrl || this.middlewareUrl;
    }

    async login(username, password) {
      const res = await fetch(`${this.middlewareUrl}/auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || "auth_failed");
      }
      return await res.json();
    }

    async loginWithPrompt() {
      const username = window.prompt("\u7528\u6237\u540d");
      if (username === null) {
        throw new Error("cancelled");
      }
      const password = window.prompt("\u5bc6\u7801");
      if (password === null) {
        throw new Error("cancelled");
      }
      return await this.login(username, password);
    }

    connect(sessionId, handlers) {
      const wsUrl = this._toWebSocketUrl(this.socketUrl);
      const socket = new WebSocket(wsUrl);
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ type: "register", sessionId: sessionId }));
        if (handlers && handlers.onConnect) {
          handlers.onConnect(sessionId);
        }
      });
      socket.addEventListener("message", (evt) => {
        let data;
        try {
          data = JSON.parse(evt.data);
        } catch {
          return;
        }
        if (handlers && handlers.onMessage) {
          handlers.onMessage(data);
        }
      });
      socket.addEventListener("close", () => {
        if (handlers && handlers.onDisconnect) {
          handlers.onDisconnect();
        }
      });
      this.socket = socket;
      return socket;
    }

    send(content) {
      if (!this.socket) {
        throw new Error("not_connected");
      }
      this.socket.send(JSON.stringify({ type: "message", content: content }));
    }

    _toWebSocketUrl(url) {
      try {
        const parsed = new URL(url);
        if (parsed.protocol === "http:") {
          parsed.protocol = "ws:";
        } else if (parsed.protocol === "https:") {
          parsed.protocol = "wss:";
        }
        return parsed.toString();
      } catch {
        return url;
      }
    }
  }

  window.PushChannelSDK = PushChannelSDK;
})();
