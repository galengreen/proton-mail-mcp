import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { SmtpSender, isSmtpConnectionError, type MailTransport } from "../src/smtp.ts";

function setup(sendMail: MailTransport["sendMail"]) {
  const transports: (MailTransport & EventEmitter & { closed: boolean })[] = [];
  const sender = new SmtpSender({
    idleTimeoutMs: 0,
    createTransport: () => {
      const t = Object.assign(new EventEmitter(), { sendMail, closed: false, close() { t.closed = true; } });
      transports.push(t);
      return t;
    }
  });
  return { sender, transports };
}

test("isSmtpConnectionError recognises a dropped connection", () => {
  assert.equal(isSmtpConnectionError(Object.assign(new Error("x"), { code: "ECONNECTION" })), true);
  assert.equal(isSmtpConnectionError(new Error("Connection closed unexpectedly")), true);
  assert.equal(isSmtpConnectionError(Object.assign(new Error("Invalid login"), { code: "EAUTH" })), false);
});

test("a send that fails on the connection is not retried and says it may have gone", async () => {
  let calls = 0;
  const { sender, transports } = setup(async () => {
    calls++;
    throw Object.assign(new Error("Connection closed unexpectedly"), { code: "ECONNECTION" });
  });
  await assert.rejects(sender.send({}), /may or may not have gone out/);
  assert.equal(calls, 1);
  assert.equal(transports[0]?.closed, true);
});

test("the transport is reused between sends", async () => {
  const { sender, transports } = setup(async () => ({ messageId: "<1@x>" }));
  await sender.send({});
  await sender.send({});
  assert.equal(transports.length, 1);
});

test("a transport error event does not crash and leads to a new transport", async () => {
  const { sender, transports } = setup(async () => ({}));
  await sender.send({});
  assert.doesNotThrow(() => transports[0]!.emit("error", new Error("boom")));
  await sender.send({});
  assert.equal(transports.length, 2);
});
