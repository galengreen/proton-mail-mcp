import test from "node:test";
import assert from "node:assert/strict";
import { simpleParser, type ParsedMail } from "mailparser";
import { bodyFields, messageBody, quotedReply, replyRecipients, replySubject, threadingHeaders } from "../src/message.ts";
import { rawMessage } from "./helpers/messages.ts";

const SELF = "me@proton.me";
const parse = async (options: Parameters<typeof rawMessage>[0]) => simpleParser(await rawMessage(options));

test("messageBody prefers plain text", async () => {
  const body = messageBody(await parse({ text: "Plain words", html: "<p>HTML words</p>" }));
  assert.equal(body.source, "plain");
  assert.match(body.text, /Plain words/);
  assert.match(body.html ?? "", /HTML words/);
});

test("messageBody converts HTML when the plain part is only padding", async () => {
  const body = messageBody(await parse({ text: "͏ ­​", html: "<p>The real <b>content</b></p>" }));
  assert.equal(body.source, "html");
  assert.match(body.text, /The real content/);
});

test("messageBody converts HTML inside multipart/related, where mailparser gives no text", async () => {
  const mail = await parse({
    html: '<p>Your order has shipped</p><img src="cid:logo@x">',
    attachments: [{ filename: "logo.png", content: Buffer.from("png"), cid: "logo@x" }]
  });
  const body = messageBody(mail);
  assert.equal(body.source, "html");
  assert.match(body.text, /Your order has shipped/);
});

test("messageBody says so when there is nothing to read", () => {
  assert.equal(messageBody({ text: undefined, html: false }).source, "none");
  assert.equal(messageBody({ text: "", html: '<img src="x">' }).source, "none");
});

test("bodyFields leaves HTML out unless asked, and caps size", () => {
  const body = { text: "x".repeat(30), html: "<p>" + "y".repeat(30) + "</p>", source: "plain" as const };
  assert.deepEqual(bodyFields(body, false), { text: body.text, bodySource: "plain", hasHtml: true });
  const capped = bodyFields(body, true, 10);
  assert.equal(capped.text, "x".repeat(10));
  assert.equal(capped.truncated, true);
  assert.match(capped.note ?? "", /30 bytes/);
  assert.equal(capped.html?.length, 10);
  assert.equal(capped.htmlTruncated, true);
});

test("replySubject adds Re: only once, in any language's usual form", () => {
  assert.equal(replySubject("Invoice"), "Re: Invoice");
  for (const s of ["Re: Invoice", "RE: Invoice", "re : Invoice", "Re[2]: Invoice", "AW: Rechnung", "SV: Faktura"]) assert.equal(replySubject(s), s);
  assert.equal(replySubject("Regarding the invoice"), "Re: Regarding the invoice");
  assert.equal(replySubject(undefined), "Re: ");
});

test("a reply goes to Reply-To when the sender set one", async () => {
  const mail = await parse({ from: "noreply@shop.example", replyTo: '"Shop Support" <support@shop.example>', to: SELF });
  assert.deepEqual(replyRecipients(mail, SELF, false), { to: '"Shop Support" <support@shop.example>' });
});

test("reply-all puts everyone else on Cc, once, without you", async () => {
  const mail = await parse({
    from: '"Anna" <anna@example.org>',
    to: ["ME@proton.me", "bob@example.org", "anna@example.org"],
    cc: ["carol@example.org", "bob@example.org"]
  });
  assert.deepEqual(replyRecipients(mail, SELF, false), { to: '"Anna" <anna@example.org>' });
  assert.deepEqual(replyRecipients(mail, SELF, true), { to: '"Anna" <anna@example.org>', cc: "bob@example.org, carol@example.org" });
});

test("replying to your own message goes to its recipients", async () => {
  const mail = await parse({ from: SELF, to: "anna@example.org", cc: "bob@example.org" });
  assert.deepEqual(replyRecipients(mail, SELF, true), { to: "anna@example.org", cc: "bob@example.org" });
});

test("a note to yourself is answered to yourself", async () => {
  const mail = await parse({ from: SELF, to: SELF });
  assert.deepEqual(replyRecipients(mail, SELF, true), { to: SELF });
});

test("threadingHeaders chain the references", () => {
  assert.deepEqual(
    threadingHeaders({ messageId: "<b@x>", references: ["<a@x>"] } as ParsedMail),
    { inReplyTo: "<b@x>", references: ["<a@x>", "<b@x>"] }
  );
  assert.deepEqual(threadingHeaders({ messageId: "<a@x>", references: undefined } as ParsedMail), { inReplyTo: "<a@x>", references: ["<a@x>"] });
});

test("quotedReply puts the quoted original under the reply", async () => {
  const original = await parse({ from: '"Anna" <anna@example.org>', text: "Are we still on for Friday?\nCheers" });
  const reply = quotedReply({ text: "Yes, see you then.", html: "<p>Yes, see you then.</p>" }, original);
  assert.equal(
    reply.text,
    "Yes, see you then.\n\nOn Thu, 01 Oct 2026 09:00:00 GMT, Anna wrote:\n> Are we still on for Friday?\n> Cheers\n"
  );
  assert.match(reply.html ?? "", /<blockquote[^>]*>Are we still on for Friday\?<br>\nCheers<\/blockquote>/);
});

test("quotedReply escapes the original in HTML so its markup cannot leak in", async () => {
  const original = await parse({ from: "a@example.org", text: "<script>x</script>" });
  assert.doesNotMatch(quotedReply({ text: "ok", html: "<p>ok</p>" }, original).html ?? "", /<script>/);
});
