
const express = require('express');
const http = require('http');
const { WebSocketServer } = require("ws");
const bodyParser = require('body-parser');
const cors = require('cors');
const { randomUUID } = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 3001;
// Default OpenClaw webhook URL (should match plugin config)
const OPENCLAW_WEBHOOK_URL = process.env.OPENCLAW_WEBHOOK_URL || "http://localhost:3002/webhook";

const sessions = new Map();
const registrations = new Map();

wss.on('connection', (socket) => {
  console.log('a user connected');

  socket.on('message', async (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (data?.type === "register" && typeof data.sessionId === "string") {
      const sessionId = data.sessionId;
      const existing = sessions.get(sessionId);
      if (existing && existing !== socket) {
        try {
          existing.close(4001, "Session already connected");
        } catch {
        }
      }
      console.log(`User registered with sessionId: ${sessionId}`);
      sessions.set(sessionId, socket);
      socket.sessionId = sessionId;
      return;
    }
    if (data?.type === "message" && typeof data.content === "string") {
      console.log(`Message from ${socket.sessionId}:`, data);
      const sessionId = socket.sessionId;
      if (!sessionId) {
          console.error("Socket not registered with sessionId");
          return;
      }
      try {
          const fetch = global.fetch || (await import('node-fetch')).default;
          const res = await fetch(OPENCLAW_WEBHOOK_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sessionId, content: data.content })
          });
          
          if (!res.ok) {
              console.error(`Failed to forward to OpenClaw: ${res.statusText}`);
          }
      } catch (e) {
          console.error("Failed to forward to OpenClaw", e);
      }
    }
  });

  socket.on('close', () => {
    console.log('user disconnected');
    if (socket.sessionId) {
        const current = sessions.get(socket.sessionId);
        if (current === socket) {
            sessions.delete(socket.sessionId);
        }
    }
  });
});

app.post('/register', (req, res) => {
    const { username, password, department, name, email, phone, title } = req.body || {};
    const fields = { username, password, department, name, email, phone, title };
    const missing = Object.entries(fields)
        .filter(([, value]) => typeof value !== 'string' || value.trim() === '')
        .map(([key]) => key);
    if (missing.length > 0) {
        return res.status(400).json({ error: `Missing or invalid fields: ${missing.join(', ')}` });
    }
    const sessionId = randomUUID();
    registrations.set(sessionId, {
        username: username.trim(),
        password: password.trim(),
        department: department.trim(),
        name: name.trim(),
        email: email.trim(),
        phone: phone.trim(),
        title: title.trim(),
        createdAt: Date.now()
    });
    res.status(200).json({ sessionId });
});

app.post('/auth', (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || username.trim() === '' || typeof password !== 'string' || password.trim() === '') {
        return res.status(400).json({ error: "Missing or invalid username/password" });
    }
    const normalizedUsername = username.trim();
    const normalizedPassword = password.trim();
    const found = Array.from(registrations.entries()).find(([, record]) => {
        return record.username === normalizedUsername && record.password === normalizedPassword;
    });
    if (!found) {
        return res.status(401).json({ error: "Invalid credentials" });
    }
    const [sessionId] = found;
    res.status(200).json({ sessionId });
});

// Endpoint for OpenClaw to push messages
app.post('/send', (req, res) => {
    const { sessionId, content } = req.body;
    console.log(`Received push request for ${sessionId}: ${content}`);
    
    if (!sessionId || !content) {
        return res.status(400).send("Missing sessionId or content");
    }

    const socket = sessions.get(sessionId);
    if (socket) {
        socket.send(JSON.stringify({ type: "message", content, from: 'OpenClaw' }));
        console.log(`Sent message to ${sessionId}`);
        res.status(200).send("Sent");
    } else {
        console.log(`Session ${sessionId} not found`);
        res.status(404).send("Session not found");
    }
});

server.listen(PORT, () => {
  console.log(`Middleware listening on port ${PORT}`);
});
