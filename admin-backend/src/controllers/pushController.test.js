const assert = require("node:assert/strict");
const test = require("node:test");
const pushController = require("./pushController");
const { connections } = require("../websocket/index");

function createOpenSocket(messages) {
  return {
    OPEN: 1,
    readyState: 1,
    sessionIds: new Set(["session-1"]),
    send(message) {
      messages.push(JSON.parse(message));
    },
  };
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

test("send assigns a distinct answer id to each outbound stream", async (t) => {
  const messages = [];
  connections.set("demo-agent", new Set([createOpenSocket(messages)]));
  t.after(() => {
    connections.delete("demo-agent");
  });

  await pushController.send({
    request: { body: { agentId: "demo-agent", sessionId: "session-1", content: "first" } },
  });
  await pushController.send({
    request: { body: { agentId: "demo-agent", sessionId: "session-1", content: "second" } },
  });

  await waitFor(
    () => messages.filter((message) => message.type === "stream_end").length === 2,
    "two stream completions",
  );

  const starts = messages.filter((message) => message.type === "stream_start");
  assert.equal(starts.length, 2);
  assert.notEqual(starts[0].answerMessageId, starts[1].answerMessageId);

  const streamIds = new Set(
    messages
      .filter((message) => message.type === "stream")
      .map((message) => message.answerMessageId),
  );
  assert.deepEqual(streamIds, new Set(starts.map((message) => message.answerMessageId)));
});

test("send falls back to the socket subscribed to the session id", async (t) => {
  const messages = [];
  connections.set("main", new Set([createOpenSocket(messages)]));
  t.after(() => {
    connections.delete("main");
  });

  const ctx = {
    request: {
      body: {
        agentId: "session-1",
        sessionId: "session-1",
        content: "async result",
      },
    },
  };

  await pushController.send(ctx);

  assert.equal(ctx.status, 200);
  assert.equal(ctx.body, "Sent");

  await waitFor(
    () => messages.some((message) => message.type === "stream_end"),
    "fallback stream completion",
  );

  assert.equal(messages[0].type, "stream_start");
  assert.equal(messages[0].sessionId, "session-1");
  assert.ok(messages[0].answerMessageId.startsWith("push-main:session-1-"));
});

test("send broadcasts structured subagent events without text streaming", async (t) => {
  const messages = [];
  connections.set("main", new Set([createOpenSocket(messages)]));
  t.after(() => {
    connections.delete("main");
  });

  const ctx = {
    request: {
      body: {
        agentId: "main",
        sessionId: "session-1",
        event: {
          type: "subagent_stream",
          agentId: "coder",
          childSessionKey: "agent:coder:subagent:child",
          toolCallId: "tool-2",
          toolName: "shell",
          content: "Tool call: shell",
        },
      },
    },
  };

  await pushController.send(ctx);

  assert.equal(ctx.status, 200);
  assert.equal(ctx.body, "Sent");
  assert.deepEqual(messages, [
    {
      type: "subagent_stream",
      agentId: "coder",
      childSessionKey: "agent:coder:subagent:child",
      toolCallId: "tool-2",
      toolName: "shell",
      content: "Tool call: shell",
      sessionId: "session-1",
    },
  ]);
});
