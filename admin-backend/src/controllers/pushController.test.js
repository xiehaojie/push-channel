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
