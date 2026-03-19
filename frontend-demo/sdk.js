class PushChannelSDK {
    constructor(url, sessionId) {
        this.url = url;
        this.sessionId = sessionId;
        this.socket = null;
        this.callbacks = {
            message: null,
            streamStart: null,
            streamChunk: null,
            streamEnd: null,
            error: null,
            close: null
        };
        this.pingInterval = null;
    }

    connect() {
        const wsUrl = this._toWebSocketUrl(this.url);
        this.socket = new WebSocket(wsUrl);

        this.socket.onopen = () => {
            console.log('Connected to server');
            this.socket.send(JSON.stringify({ type: 'register', sessionId: this.sessionId }));
            
            // Start heartbeat
            this.pingInterval = setInterval(() => {
                if (this.socket.readyState === WebSocket.OPEN) {
                    this.socket.send(JSON.stringify({ type: 'ping' }));
                }
            }, 30000);
        };

        this.socket.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                
                if (data.type === 'pong') {
                    // Heartbeat received
                    return;
                }

                if (data.type === 'stream_start' && this.callbacks.streamStart) {
                    this.callbacks.streamStart(data.from);
                } else if (data.type === 'stream' && this.callbacks.streamChunk) {
                    this.callbacks.streamChunk(data.content);
                } else if (data.type === 'stream_end' && this.callbacks.streamEnd) {
                    this.callbacks.streamEnd();
                } else if (data.type === 'message' && this.callbacks.message) {
                    this.callbacks.message(data.content);
                } else if (data.type === 'done' && this.callbacks.streamEnd) {
                    this.callbacks.streamEnd();
                }
            } catch (err) {
                console.error('Error parsing message', err);
            }
        };

        this.socket.onerror = (error) => {
            console.error('WebSocket error:', error);
            if (this.callbacks.error) this.callbacks.error(error);
        };

        this.socket.onclose = () => {
            console.log('Disconnected from server');
            if (this.pingInterval) clearInterval(this.pingInterval);
            if (this.callbacks.close) this.callbacks.close();
        };
    }

    sendMessage(content, agentId) {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            const payload = { type: 'message', content };
            if (agentId) {
                payload.agentId = agentId;
            }
            this.socket.send(JSON.stringify(payload));
        } else {
            console.error('Socket is not open');
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

    onStreamStart(callback) {
        this.callbacks.streamStart = callback;
    }

    onStreamChunk(callback) {
        this.callbacks.streamChunk = callback;
    }

    onStreamEnd(callback) {
        this.callbacks.streamEnd = callback;
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
            if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
            else if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
            return parsed.toString();
        } catch {
            return url;
        }
    }
}
