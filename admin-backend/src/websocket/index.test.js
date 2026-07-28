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

test("processSSEEvent preserves child session details on subagent events", () => {
  delete require.cache[require.resolve("./index")];
  const { processSSEEvent } = require("./index");

  const childSessionKey = "agent:researcher:subagent:child";
  const callResult = processSSEEvent(
    "main",
    `data: ${JSON.stringify({
      type: "subagent_tool_call",
      agentId: "researcher",
      label: "Researcher",
      childSessionKey,
      toolCallId: "tool-1",
      toolName: "sessions_yield",
      args: { reason: "need context" },
    })}`,
    "session-subagents",
    "query-subagents",
    "answer-subagents",
  );

  assert.equal(callResult.messages.length, 1);
  assert.equal(callResult.messages[0].type, "subagent_tool_call");
  assert.equal(callResult.messages[0].agentId, "researcher");
  assert.equal(callResult.messages[0].label, "Researcher");
  assert.equal(callResult.messages[0].childSessionKey, childSessionKey);
  assert.equal(callResult.messages[0].toolCallId, "tool-1");
  assert.equal(callResult.messages[0].toolName, "sessions_yield");
  assert.deepEqual(callResult.messages[0].args, { reason: "need context" });
  assert.equal(callResult.messages[0].sessionId, "session-subagents");
  assert.equal(callResult.messages[0].queryMessageId, "query-subagents");

  const result = processSSEEvent(
    "main",
    `data: ${JSON.stringify({
      type: "subagent_tool_result",
      agentId: "researcher",
      childSessionKey,
      toolCallId: "tool-1",
      toolName: "sessions_yield",
      content: [{ text: "yielded" }],
      isError: false,
    })}`,
    "session-subagents",
    "query-subagents",
    "answer-subagents",
  );

  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].type, "subagent_tool_result");
  assert.deepEqual(result.messages[0].content, [{ text: "yielded" }]);
  assert.equal(result.messages[0].isError, false);

  const message = processSSEEvent(
    "main",
    `data: ${JSON.stringify({
      type: "subagent_message",
      agentId: "researcher",
      childSessionKey,
      messageId: "assistant-1",
      content: "我先查询天气。",
    })}`,
    "session-subagents",
    "query-subagents",
    "answer-subagents",
  );

  assert.equal(message.messages.length, 1);
  assert.equal(message.messages[0].type, "subagent_message");
  assert.equal(message.messages[0].messageId, "assistant-1");
  assert.equal(message.messages[0].content, "我先查询天气。");
});

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

test("message flow forwards structured mentions to OpenClaw", { timeout: 3000 }, async (t) => {
  let receivedPayload;
  const upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      receivedPayload = JSON.parse(body);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
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
  socket.send(JSON.stringify({ type: "register", agentId: "main", sessionId: "session-mentions" }));
  await messages.waitFor((data) => data.type === "registered", "registered");

  socket.send(
    JSON.stringify({
      type: "message",
      content: "Please ask @researcher and @coder",
      sessionId: "session-mentions",
      mentions: [
        { agentId: "researcher", label: "researcher" },
        { agentId: "coder", label: "coder" },
      ],
    }),
  );

  await waitFor(() => Boolean(receivedPayload), "upstream payload");
  assert.deepEqual(receivedPayload.mentions, [
    { agentId: "researcher", label: "researcher" },
    { agentId: "coder", label: "coder" },
  ]);
});

test("subagent SSE events are broadcast to the active session", { timeout: 3000 }, async (t) => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          type: "subagent_start",
          agentId: "researcher",
          label: "Researcher",
          childSessionKey: "agent:researcher:subagent:child",
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          type: "subagent_tool_call",
          agentId: "researcher",
          childSessionKey: "agent:researcher:subagent:child",
          toolCallId: "tool-1",
          toolName: "sessions_yield",
          args: { reason: "reading docs" },
        })}\n\n`,
      );
      res.write(`data: ${JSON.stringify({ type: "subagent_result", agentId: "researcher", content: "found answer" })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "subagent_error", agentId: "coder", message: "missing workspace" })}\n\n`);
      res.write(
        `data: ${JSON.stringify({
          type: "subagent_end",
          agentId: "researcher",
          childSessionKey: "agent:researcher:subagent:child",
          status: "success",
        })}\n\n`,
      );
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
  socket.send(JSON.stringify({ type: "register", agentId: "main", sessionId: "session-subagents" }));
  await messages.waitFor((data) => data.type === "registered", "registered");

  socket.send(
    JSON.stringify({
      type: "message",
      content: "Please ask @researcher",
      sessionId: "session-subagents",
      queryMessageId: "query-subagents",
      answerMessageId: "answer-subagents",
    }),
  );

  const start = await messages.waitFor((data) => data.type === "subagent_start", "subagent_start");
  assert.equal(start.sessionId, "session-subagents");
  assert.equal(start.queryMessageId, "query-subagents");
  assert.equal(start.agentId, "researcher");
  assert.equal(start.label, "Researcher");
  assert.equal(start.childSessionKey, "agent:researcher:subagent:child");

  const stream = await messages.waitFor((data) => data.type === "subagent_tool_call", "subagent_tool_call");
  assert.equal(stream.agentId, "researcher");
  assert.deepEqual(stream.args, { reason: "reading docs" });
  assert.equal(stream.sessionId, "session-subagents");
  assert.equal(stream.childSessionKey, "agent:researcher:subagent:child");
  assert.equal(stream.toolCallId, "tool-1");
  assert.equal(stream.toolName, "sessions_yield");

  const result = await messages.waitFor((data) => data.type === "subagent_result", "subagent_result");
  assert.equal(result.agentId, "researcher");
  assert.equal(result.content, "found answer");

  const error = await messages.waitFor((data) => data.type === "subagent_error", "subagent_error");
  assert.equal(error.agentId, "coder");
  assert.equal(error.message, "missing workspace");

  const end = await messages.waitFor((data) => data.type === "subagent_end", "subagent_end");
  assert.equal(end.agentId, "researcher");
  assert.equal(end.status, "success");
  assert.equal(end.childSessionKey, "agent:researcher:subagent:child");
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
