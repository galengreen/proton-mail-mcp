import test from "node:test";
import assert from "node:assert/strict";
import { ImapSession, isConnectionLost } from "../src/imap/session.ts";
import { FakeAccount, type FakeClient } from "./helpers/fake-mail.ts";

function setup() {
  const account = new FakeAccount();
  const clients: FakeClient[] = [];
  const session = new ImapSession({
    idleTimeoutMs: 0,
    createClient: () => {
      const client = account.client();
      clients.push(client);
      return client;
    }
  });
  return { session, clients };
}

test("isConnectionLost tells dropped connections from other errors", () => {
  assert.equal(isConnectionLost(new Error("Socket closed unexpectedly")), true);
  assert.equal(isConnectionLost(Object.assign(new Error("x"), { code: "ECONNRESET" })), true);
  assert.equal(isConnectionLost(new Error("Mailbox doesn't exist: Foo")), false);
});

test("the connection is shared between calls", async () => {
  const { session, clients } = setup();
  await session.run(async (c) => c.noop(), "repeatable");
  await session.run(async (c) => c.noop(), "repeatable");
  assert.equal(clients.length, 1);
});

test("an error event after connecting does not crash and leads to a reconnect", async () => {
  const { session, clients } = setup();
  await session.run(async () => {}, "repeatable");
  // Without a listener, emitting 'error' throws.
  assert.doesNotThrow(() => clients[0]!.emit("error", new Error("read ECONNRESET")));
  await session.run(async () => {}, "repeatable");
  assert.equal(clients.length, 2);
});

test("a repeatable operation is retried once on a new connection", async () => {
  const { session, clients } = setup();
  let calls = 0;
  const result = await session.run(async () => {
    if (++calls === 1) throw new Error("Connection closed");
    return "done";
  }, "repeatable");
  assert.equal(result, "done");
  assert.equal(calls, 2);
  assert.equal(clients.length, 2);
});

test("a once operation is never retried", async () => {
  const { session } = setup();
  let calls = 0;
  await assert.rejects(session.run(async () => {
    calls++;
    throw new Error("Command timed out");
  }, "once"), /timed out/);
  assert.equal(calls, 1);
});

test("a once operation replaces a stale connection before it starts", async () => {
  const { session, clients } = setup();
  await session.run(async () => {}, "repeatable");
  clients[0]!.failNext.set("noop", new Error("Connection closed"));
  let calls = 0;
  await session.run(async () => {
    calls++;
  }, "once");
  assert.equal(calls, 1);
  assert.equal(clients.length, 2);
});

test("ordinary errors are not retried and keep the connection", async () => {
  const { session, clients } = setup();
  let calls = 0;
  await assert.rejects(session.run(async () => {
    calls++;
    throw new Error("Mailbox doesn't exist");
  }, "repeatable"));
  await session.run(async () => {}, "repeatable");
  assert.equal(calls, 1);
  assert.equal(clients.length, 1);
});

test("close logs out", async () => {
  const { session, clients } = setup();
  await session.run(async () => {}, "repeatable");
  await session.close();
  assert.equal(clients[0]!.usable, false);
});
