const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const WebSocket = require("ws");

function waitForMessage(socket, predicate, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${label}`));
    }, 1500);

    const onMessage = (raw) => {
      const data = JSON.parse(raw.toString());
      if (predicate(data)) {
        cleanup();
        resolve(data);
      }
    };

    const onClose = (code, reason) => {
      cleanup();
      reject(new Error(`Socket closed before ${label}: ${code} ${reason.toString()}`));
    };

    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
    };

    socket.on("message", onMessage);
    socket.on("close", onClose);
  });
}

function waitFor(predicate, label) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > 1500) {
        reject(new Error(`Timed out waiting for ${label}`));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}

function collectMessages(socket) {
  const messages = [];
  const waiters = [];

  socket.on("message", (raw) => {
    const data = JSON.parse(raw.toString());
    messages.push(data);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(data)) continue;
      waiter.cleanup();
      waiter.resolve(data);
    }
  });

  return {
    waitFor(predicate, label) {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);

      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          cleanup: () => {
            clearTimeout(timer);
            const index = waiters.indexOf(waiter);
            if (index !== -1) waiters.splice(index, 1);
          },
        };
        const timer = setTimeout(() => {
          waiter.cleanup();
          reject(new Error(`Timed out waiting for ${label}`));
        }, 1500);
        waiters.push(waiter);
      });
    },
  };
}

function closeConnections(connections) {
  for (const sockets of connections.values()) {
    for (const socket of sockets) {
      socket.close();
    }
  }
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function createSocket(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

test("register accepts a demo agent without local auth lookup", { timeout: 3000 }, async (t) => {
  const authService = require("../services/authService");
  const originalValidateAgent = authService.validateAgent;
  let validateAgentCalled = false;
  authService.validateAgent = async () => {
    validateAgentCalled = true;
    return null;
  };
  t.after(() => {
    authService.validateAgent = originalValidateAgent;
  });

  const server = http.createServer();
  const { initWebSocket } = require("./index");
  const connections = initWebSocket(server);
  const port = await listen(server);
  t.after(async () => {
    closeConnections(connections);
    await closeServer(server);
  });

  const socket = await createSocket(port);
  t.after(() => socket.close());

  socket.send(JSON.stringify({ type: "register", agentId: "demo-agent" }));

  const registered = await waitForMessage(socket, (data) => data.type === "registered", "registered");
  assert.equal(validateAgentCalled, false);
  assert.equal(registered.agentId, "demo-agent");
  assert.deepEqual(registered.files, []);
  assert.equal(registered.path, "");
});

test("message flow forwards ids and handles cumulative SSE snapshots", { timeout: 3000 }, async (t) => {
  const longSnapshot = `${"A".repeat(220)} done`;
  const upstream = http.createServer((req, res) => {
    assert.equal(req.method, "POST");
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      const payload = JSON.parse(body);
      assert.equal(payload.agentId, "demo-agent");
      assert.equal(payload.sessionId, "session-1");
      assert.equal(payload.content, "hello");

      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ type: "content", delta: longSnapshot })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
      res.end();
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(async () => {
    await closeServer(upstream);
  });

  process.env.OPENCLAW_WEBHOOK_URL = `http://127.0.0.1:${upstreamPort}/webhook`;

  delete require.cache[require.resolve("./index")];
  const server = http.createServer();
  const { initWebSocket } = require("./index");
  const connections = initWebSocket(server);
  const port = await listen(server);
  t.after(async () => {
    closeConnections(connections);
    await closeServer(server);
  });

  const socket = await createSocket(port);
  const messages = collectMessages(socket);
  t.after(() => socket.close());
  socket.send(JSON.stringify({ type: "register", agentId: "demo-agent" }));
  await messages.waitFor((data) => data.type === "registered", "registered");

  socket.send(
    JSON.stringify({
      type: "message",
      content: "hello",
      sessionId: "session-1",
      queryMessageId: "query-1",
      answerMessageId: "answer-1",
    }),
  );

  const sent = await messages.waitFor((data) => data.type === "message_sent", "message_sent");
  assert.equal(sent.sessionId, "session-1");
  assert.equal(sent.queryMessageId, "query-1");
  assert.equal(sent.answerMessageId, "answer-1");

  const start = await messages.waitFor((data) => data.type === "stream_start", "stream_start");
  assert.equal(start.sessionId, "session-1");
  assert.equal(start.queryMessageId, "query-1");
  assert.equal(start.answerMessageId, "answer-1-1");

  const snapshot = await messages.waitFor((data) => data.type === "stream_snapshot", "stream_snapshot");
  assert.equal(snapshot.snapshot, longSnapshot);
  assert.equal(snapshot.sessionId, "session-1");
  assert.equal(snapshot.queryMessageId, "query-1");
  assert.equal(snapshot.answerMessageId, "answer-1-1");

  const end = await messages.waitFor((data) => data.type === "stream_end", "stream_end");
  assert.equal(end.sessionId, "session-1");
  assert.equal(end.queryMessageId, "query-1");
  assert.equal(end.answerMessageId, "answer-1-1");
});

test("messages stay scoped to the active session for the same agent", { timeout: 3000 }, async (t) => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ type: "content", delta: "reply" })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
      res.end();
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(async () => {
    await closeServer(upstream);
  });

  process.env.OPENCLAW_WEBHOOK_URL = `http://127.0.0.1:${upstreamPort}/webhook`;

  delete require.cache[require.resolve("./index")];
  const server = http.createServer();
  const { initWebSocket } = require("./index");
  const connections = initWebSocket(server);
  const port = await listen(server);
  t.after(async () => {
    closeConnections(connections);
    await closeServer(server);
  });

  const first = await createSocket(port);
  const second = await createSocket(port);
  const firstMessages = collectMessages(first);
  const secondMessages = collectMessages(second);
  t.after(() => {
    first.close();
    second.close();
  });

  first.send(JSON.stringify({ type: "register", agentId: "demo-agent", sessionId: "session-a" }));
  second.send(JSON.stringify({ type: "register", agentId: "demo-agent", sessionId: "session-b" }));
  await firstMessages.waitFor((data) => data.type === "registered", "first registered");
  await secondMessages.waitFor((data) => data.type === "registered", "second registered");

  first.send(JSON.stringify({ type: "message", content: "hello", sessionId: "session-a" }));

  const firstStream = await firstMessages.waitFor(
    (data) => data.type === "stream" && data.content === "reply",
    "first stream",
  );
  assert.equal(firstStream.sessionId, "session-a");

  await assert.rejects(
    secondMessages.waitFor((data) => data.type === "stream" || data.type === "message_sent", "leaked event"),
    /Timed out waiting for leaked event/,
  );
});

test("same session messages are forwarded to OpenClaw serially", { timeout: 5000 }, async (t) => {
  let activeRequests = 0;
  let maxActiveRequests = 0;
  let releaseFirstResponse;
  const receivedBodies = [];

  const upstream = http.createServer((req, res) => {
    activeRequests += 1;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);

    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      receivedBodies.push(JSON.parse(body));
      res.writeHead(200, { "Content-Type": "text/event-stream" });

      if (receivedBodies.length === 1) {
        releaseFirstResponse = () => {
          res.write(`data: ${JSON.stringify({ type: "content", delta: "first" })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
          res.end();
          activeRequests -= 1;
        };
        return;
      }

      res.write(`data: ${JSON.stringify({ type: "content", delta: "second" })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
      res.end();
      activeRequests -= 1;
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(async () => {
    await closeServer(upstream);
  });

  process.env.OPENCLAW_WEBHOOK_URL = `http://127.0.0.1:${upstreamPort}/webhook`;

  delete require.cache[require.resolve("./index")];
  const server = http.createServer();
  const { initWebSocket } = require("./index");
  const connections = initWebSocket(server);
  const port = await listen(server);
  t.after(async () => {
    closeConnections(connections);
    await closeServer(server);
  });

  const socket = await createSocket(port);
  const messages = collectMessages(socket);
  t.after(() => socket.close());

  socket.send(JSON.stringify({ type: "register", agentId: "demo-agent", sessionId: "session-a" }));
  await messages.waitFor((data) => data.type === "registered", "registered");

  socket.send(JSON.stringify({ type: "message", content: "first", sessionId: "session-a" }));
  socket.send(JSON.stringify({ type: "message", content: "second", sessionId: "session-a" }));

  await waitFor(
    () => receivedBodies.length === 1 && typeof releaseFirstResponse === "function",
    "first upstream request",
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(receivedBodies.length, 1);
  assert.equal(maxActiveRequests, 1);

  releaseFirstResponse();
  await waitFor(() => receivedBodies.length === 2, "second upstream request");
  assert.equal(maxActiveRequests, 1);
  assert.deepEqual(
    receivedBodies.map((body) => body.content),
    ["first", "second"],
  );
});
