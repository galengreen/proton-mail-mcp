import test from "node:test";
import assert from "node:assert/strict";
import { simpleParser } from "mailparser";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildConfig } from "../src/config.ts";
import { ImapSession } from "../src/imap/session.ts";
import { Mailbox, hasAttachments } from "../src/mailbox.ts";
import { createServer } from "../src/server.ts";
import { SmtpSender } from "../src/smtp.ts";
import type { LocalFile } from "../src/files.ts";
import { FakeAccount, type FakeClient } from "./helpers/fake-mail.ts";
import { rawMessage } from "./helpers/messages.ts";

const SELF = "me@proton.me";

interface Setup {
  account: FakeAccount;
  client: Client;
  clients: FakeClient[];
  sent: Record<string, unknown>[];
  call: (name: string, args?: Record<string, unknown>) => Promise<{ isError: boolean; text: string; content: unknown[] }>;
  json: (name: string, args?: Record<string, unknown>) => Promise<any>;
}

async function setup({ allowSend = false, files = {} as Record<string, string>, addresses = "" } = {}): Promise<Setup> {
  const account = new FakeAccount();
  account.addFolder("Labels/Receipts");
  account.addFolder("Folders/Travel");
  const clients: FakeClient[] = [];
  const session = new ImapSession({
    idleTimeoutMs: 0,
    createClient: () => {
      const c = account.client();
      clients.push(c);
      return c;
    }
  });
  const sent: Record<string, unknown>[] = [];
  const sender = allowSend
    ? new SmtpSender({ idleTimeoutMs: 0, createTransport: () => ({ sendMail: async (m) => { sent.push(m as Record<string, unknown>); return { messageId: "<sent@x>" }; }, close() {} }) })
    : null;
  const readFile = async (path: string): Promise<LocalFile> => {
    const content = files[path];
    if (content === undefined) throw new Error(`${path} is outside the folders attachments may come from`);
    return { filename: path.split("/").pop()!, content: Buffer.from(content) };
  };
  const server = createServer({ config: buildConfig({ PROTON_BRIDGE_USERNAME: SELF, PROTON_BRIDGE_ADDRESSES: addresses }, {}), mailbox: new Mailbox(session), sender, readFile });
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { type: string; text?: string }[];
    return { isError: !!result.isError, text: content[0]?.text ?? "", content };
  };
  const json = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await call(name, args);
    if (result.isError) throw new Error(result.text);
    return JSON.parse(result.text);
  };
  return { account, client, clients, sent, call, json };
}

async function addMail(account: FakeAccount, folder: string, options: Parameters<typeof rawMessage>[0], flags: string[] = []) {
  return account.add(folder, await rawMessage(options), flags);
}

test("the tools are listed with annotations, and sending only when allowed", async () => {
  const { client } = await setup();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "add_label", "create_draft", "create_reply_draft", "delete_email", "list_emails", "list_folders",
    "mark_email", "move_email", "read_attachment", "read_email", "remove_label", "search_emails"
  ]);
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  for (const name of ["list_folders", "list_emails", "search_emails", "read_email", "read_attachment"]) {
    assert.equal(byName[name]?.annotations?.readOnlyHint, true, name);
  }
  assert.equal(byName.delete_email?.annotations?.destructiveHint, true);
  assert.equal(byName.create_draft?.annotations?.destructiveHint, false);
  assert.match(client.getInstructions() ?? "", /untrusted/);

  const withSend = await setup({ allowSend: true });
  const sendTools = (await withSend.client.listTools()).tools.filter((t) => t.name === "send_email" || t.name === "reply_to_email");
  assert.equal(sendTools.length, 2);
  assert.ok(sendTools.every((t) => t.annotations?.destructiveHint === true && t.annotations?.openWorldHint === true));
});

test("list_emails pages from newest to oldest", async () => {
  const s = await setup();
  for (let i = 1; i <= 5; i++) await addMail(s.account, "INBOX", { from: "a@example.org", subject: `Message ${i}`, text: "x" });
  const first = await s.json("list_emails", { limit: 2 });
  assert.deepEqual(first.messages.map((m: any) => m.subject), ["Message 5", "Message 4"]);
  assert.equal(first.total, 5);
  assert.equal(first.nextOffset, 2);
  const last = await s.json("list_emails", { limit: 2, offset: 4 });
  assert.deepEqual(last.messages.map((m: any) => m.subject), ["Message 1"]);
  assert.equal(last.nextOffset, null);
  assert.deepEqual((await s.json("list_emails", { offset: 10 })).messages, []);
});

test("search_emails filters, and pages newest first", async () => {
  const s = await setup();
  await addMail(s.account, "INBOX", { from: "shop@example.org", subject: "Order shipped", text: "parcel" });
  await addMail(s.account, "INBOX", { from: "anna@example.org", subject: "Lunch?", text: "Friday" }, ["\\Seen"]);
  await addMail(s.account, "INBOX", { from: "shop@example.org", subject: "Order delivered", text: "parcel" });
  const result = await s.json("search_emails", { from: "shop", limit: 1 });
  assert.equal(result.total, 2);
  assert.deepEqual(result.messages.map((m: any) => m.subject), ["Order delivered"]);
  assert.equal(result.nextOffset, 1);
  const unread = await s.json("search_emails", { unread: true });
  assert.deepEqual(unread.messages.map((m: any) => m.subject).sort(), ["Order delivered", "Order shipped"]);
});

test("bad arguments are refused before the mailbox is touched", async () => {
  const s = await setup();
  for (const [name, args] of [
    ["read_email", { uid: 1.5 }],
    ["read_email", { uid: 0 }],
    ["list_emails", { limit: 0 }],
    ["list_emails", { limit: 51 }],
    ["list_emails", { offset: -1 }],
    ["search_emails", { since: "yesterday" }],
    ["search_emails", { before: "2026-02-30" }],
    ["mark_email", { uid: 1, folder: "INBOX", action: "archive" }],
    ["mark_email", { uid: [], folder: "INBOX", action: "read" }]
  ] as const) {
    const result = await s.call(name, args);
    assert.equal(result.isError, true, `${name} ${JSON.stringify(args)}`);
  }
  assert.equal(s.clients.length, 0);
});

test("read_email gives text without HTML by default, with attachments", async () => {
  const s = await setup();
  const uid = await addMail(s.account, "INBOX", {
    from: "Shop <noreply@shop.example>",
    replyTo: "help@shop.example",
    to: SELF,
    subject: "Your booking",
    html: "<h1>Booked</h1><p>See you soon</p>",
    attachments: [{ filename: "booking.ics", content: "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Haircut\r\nDTSTART:20261009T010000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n", contentType: "text/calendar" }]
  });
  const mail = await s.json("read_email", { uid, folder: "INBOX" });
  assert.equal(mail.subject, "Your booking");
  assert.equal(mail.replyTo, "help@shop.example");
  assert.equal(mail.bcc, null);
  assert.equal(mail.bodySource, "html");
  assert.match(mail.text, /See you soon/);
  assert.equal(mail.hasHtml, true);
  assert.equal("html" in mail, false);
  assert.equal(mail.attachments[0].calendar.events[0].summary, "Haircut");
  const withHtml = await s.json("read_email", { uid, folder: "INBOX", includeHtml: true });
  assert.match(withHtml.html, /<h1>Booked<\/h1>/);
});

test("read_attachment returns an image block", async () => {
  const s = await setup();
  const uid = await addMail(s.account, "INBOX", { from: "a@example.org", text: "scan", attachments: [{ filename: "scan.png", content: Buffer.from("img"), contentType: "image/png" }] });
  const result = await s.call("read_attachment", { uid, folder: "INBOX", filename: "SCAN.png" });
  assert.equal(result.isError, false);
  assert.deepEqual(result.content[1], { type: "image", data: Buffer.from("img").toString("base64"), mimeType: "image/png" });
});

test("every tool reports a missing UID instead of pretending to succeed", async () => {
  const s = await setup();
  for (const [name, args] of [
    ["read_email", {}],
    ["read_attachment", { index: 0 }],
    ["mark_email", { action: "flag" }],
    ["move_email", { destination: "Archive" }],
    ["delete_email", {}],
    ["add_label", { label: "Receipts" }],
    ["remove_label", { label: "Receipts" }],
    ["create_reply_draft", { body: "x" }]
  ] as const) {
    const result = await s.call(name, { uid: 999, folder: "INBOX", ...args });
    assert.equal(result.isError, true, name);
    assert.match(result.text, /No message with UID 999 in "INBOX"/, name);
  }
  assert.equal(s.account.messages("Drafts").length, 0);
});

test("create_draft stores the message in Drafts, keeping Bcc and attachments", async () => {
  const s = await setup({ files: { "/Users/me/Documents/plan.txt": "the plan" } });
  const result = await s.json("create_draft", {
    to: "anna@example.org", bcc: "boss@example.org", subject: "Plan", body: "Attached.", attachments: ["/Users/me/Documents/plan.txt"]
  });
  assert.equal(result.saved, true);
  assert.equal(result.folder, "Drafts");
  const stored = await s.json("read_email", { folder: "Drafts", uid: result.uid });
  assert.equal(stored.bcc, "boss@example.org");
  const [draft] = s.account.messages("Drafts");
  assert.ok(draft?.flags.has("\\Draft"));
  const parsed = await simpleParser(draft!.raw);
  assert.equal(parsed.from?.text, SELF);
  assert.equal(parsed.subject, "Plan");
  assert.match(String(parsed.bcc && !Array.isArray(parsed.bcc) ? parsed.bcc.text : ""), /boss@example\.org/);
  assert.equal(parsed.attachments[0]?.filename, "plan.txt");
  assert.equal(parsed.attachments[0]?.content.toString(), "the plan");
});

test("create_draft refuses files outside the allowed folders and saves nothing", async () => {
  const s = await setup();
  const result = await s.call("create_draft", { to: "x@example.org", subject: "s", body: "b", attachments: ["/Users/me/.ssh/id_ed25519"] });
  assert.equal(result.isError, true);
  assert.match(result.text, /outside the folders/);
  assert.equal(s.account.messages("Drafts").length, 0);
});

test("create_reply_draft threads, addresses Reply-To and quotes the original", async () => {
  const s = await setup();
  const uid = await addMail(s.account, "INBOX", {
    from: "Anna <anna@example.org>", replyTo: "list@lists.example", to: [SELF, "bob@example.org"],
    subject: "Trip", text: "Shall we book the bach?", messageId: "<trip-1@example.org>"
  });
  const result = await s.json("create_reply_draft", { uid, folder: "INBOX", body: "Yes, let's.", replyAll: true });
  assert.equal(result.to, "list@lists.example");
  assert.equal(result.cc, "bob@example.org");
  assert.equal(result.subject, "Re: Trip");
  const parsed = await simpleParser(s.account.messages("Drafts")[0]!.raw);
  assert.equal(parsed.inReplyTo, "<trip-1@example.org>");
  assert.match(parsed.text ?? "", /Yes, let's\.\n\nOn .*Anna wrote:\n> Shall we book the bach\?/);
  const unquoted = await s.json("create_reply_draft", { uid, folder: "INBOX", body: "Short.", quote: false });
  assert.equal(unquoted.saved, true);
  assert.equal((await simpleParser(s.account.messages("Drafts")[1]!.raw)).text?.trim(), "Short.");
});

test("saving a draft is not retried after a timeout, so there is no duplicate", async () => {
  const s = await setup();
  await s.json("list_folders");
  s.clients[0]!.failNext.set("append", new Error("Command timed out"));
  const result = await s.call("create_draft", { to: "a@example.org", subject: "s", body: "b" });
  assert.equal(result.isError, true);
  assert.match(result.text, /may or may not have been made/);
  assert.equal(s.clients[0]!.log.filter((c) => c === "append").length, 1);
  assert.equal(s.clients.length, 1);
});

test("move, mark and delete work and delete only moves to Trash", async () => {
  const s = await setup();
  const uid = await addMail(s.account, "INBOX", { from: "a@example.org", subject: "x", text: "y" });
  await s.json("mark_email", { uid, folder: "INBOX", action: "flag" });
  assert.ok(s.account.messages("INBOX")[0]?.flags.has("\\Flagged"));
  const moved = await s.json("move_email", { uid, folder: "INBOX", destination: "Folders/Travel" });
  assert.equal(moved.to, "Folders/Travel");
  const deleted = await s.json("delete_email", { uid: moved.newUid, folder: "Folders/Travel" });
  assert.equal(deleted.movedTo, "Trash");
  assert.equal(s.account.messages("Trash").length, 1);
  const again = await s.call("delete_email", { uid: deleted.newUid, folder: "Trash" });
  assert.match(again.text, /already in Trash/);
  assert.equal(s.account.messages("Trash").length, 1);
});

test("labels are added by copying and removed only from the label folder", async () => {
  const s = await setup();
  const uid = await addMail(s.account, "INBOX", { from: "a@example.org", subject: "Receipt", text: "$5", messageId: "<r1@example.org>" });
  await addMail(s.account, "Labels/Receipts", { from: "b@example.org", subject: "Other", text: "x", messageId: "<r1@example.org.other>" });
  await s.json("add_label", { uid, folder: "INBOX", label: "Receipts" });
  assert.equal(s.account.messages("Labels/Receipts").length, 2);
  assert.equal(s.account.messages("INBOX").length, 1);
  await s.json("remove_label", { uid, folder: "INBOX", label: "Labels/Receipts" });
  // Only the exact Message-ID match is removed, and the original stays put.
  assert.deepEqual((await Promise.all(s.account.messages("Labels/Receipts").map(async (m) => (await simpleParser(m.raw)).subject))), ["Other"]);
  assert.equal(s.account.messages("INBOX").length, 1);
  const missing = await s.call("remove_label", { uid, folder: "INBOX", label: "Receipts" });
  assert.match(missing.text, /does not have the label/);
  const unknown = await s.call("add_label", { uid, folder: "INBOX", label: "Nope" });
  assert.match(unknown.text, /There is no label "Nope"\. Labels: Receipts/);
});

test("send_email and reply_to_email send once, with the same addressing as drafts", async () => {
  const s = await setup({ allowSend: true });
  const uid = await addMail(s.account, "INBOX", { from: "anna@example.org", to: SELF, subject: "Hi", text: "Hello", messageId: "<hi@example.org>" });
  await s.json("send_email", { to: "bob@example.org", subject: "Note", body: "Text" });
  await s.json("reply_to_email", { uid, folder: "INBOX", body: "Hello back", quote: false });
  assert.equal(s.sent.length, 2);
  assert.equal(s.sent[1]?.to, "anna@example.org");
  assert.equal(s.sent[1]?.inReplyTo, "<hi@example.org>");
  assert.equal(s.account.messages("Drafts").length, 0);
});

test("tools that take a UID need its folder, so a UID is never applied to INBOX by default", async () => {
  const s = await setup();
  const uid = await addMail(s.account, "INBOX", { from: "a@example.org", subject: "Keep me", text: "x" });
  for (const [name, args] of [
    ["read_email", {}],
    ["read_attachment", { index: 0 }],
    ["delete_email", {}],
    ["move_email", { destination: "Archive" }],
    ["mark_email", { action: "read" }],
    ["add_label", { label: "Receipts" }],
    ["remove_label", { label: "Receipts" }],
    ["create_reply_draft", { body: "x" }]
  ] as const) {
    const result = await s.call(name, { uid, ...args });
    assert.equal(result.isError, true, name);
    assert.match(result.text, /folder/, name);
  }
  assert.equal(s.account.messages("INBOX").length, 1);
  assert.equal(s.clients.length, 0);
});

test("list_folders gives message and unread counts", async () => {
  const s = await setup();
  await addMail(s.account, "INBOX", { from: "a@example.org", text: "x" });
  await addMail(s.account, "INBOX", { from: "a@example.org", text: "y" }, ["\\Seen"]);
  const folders = await s.json("list_folders");
  const inbox = folders.find((f: any) => f.path === "INBOX");
  assert.deepEqual(inbox, { path: "INBOX", name: "INBOX", specialUse: "\\Inbox", messages: 2, unread: 1 });
});

test("summaries include recipients, size and whether there are attachments", async () => {
  const s = await setup();
  await addMail(s.account, "INBOX", { from: "a@example.org", to: "Bob <bob@example.org>", text: "plain" });
  await addMail(s.account, "INBOX", { from: "a@example.org", to: SELF, text: "see attached", attachments: [{ filename: "a.pdf", content: "x", contentType: "application/pdf" }] });
  const { messages } = await s.json("list_emails", {});
  assert.equal(messages[0].hasAttachments, true);
  assert.equal(messages[1].hasAttachments, false);
  assert.equal(messages[1].to, "Bob <bob@example.org>");
  assert.ok(messages[0].size > 0);
});

test("hasAttachments ignores signature parts and counts real attachments", () => {
  const text = { type: "text/plain" };
  assert.equal(hasAttachments({ type: "multipart/signed", childNodes: [text, { type: "application/pgp-signature", disposition: "attachment" }] }), false);
  assert.equal(hasAttachments({ type: "multipart/mixed", childNodes: [text, { type: "image/jpeg", disposition: "attachment" }] }), true);
  assert.equal(hasAttachments({ type: "multipart/related", childNodes: [{ type: "text/html" }, { type: "image/png", disposition: "inline" }] }), false);
  assert.equal(hasAttachments(text), false);
});

test("move, mark, delete and labels take several UIDs at once, and change nothing if one is missing", async () => {
  const s = await setup();
  const uids = [];
  for (let i = 0; i < 3; i++) uids.push(await addMail(s.account, "INBOX", { from: "a@example.org", subject: `m${i}`, text: "x", messageId: `<m${i}@example.org>` }));
  await s.json("mark_email", { uid: uids, folder: "INBOX", action: "read" });
  assert.ok(s.account.messages("INBOX").every((m) => m.flags.has("\\Seen")));
  await s.json("add_label", { uid: uids.slice(0, 2), folder: "INBOX", label: "Receipts" });
  assert.equal(s.account.messages("Labels/Receipts").length, 2);
  await s.json("remove_label", { uid: uids.slice(0, 2), folder: "INBOX", label: "Receipts" });
  assert.equal(s.account.messages("Labels/Receipts").length, 0);

  const missing = await s.call("move_email", { uid: [uids[0], 999, 998], folder: "INBOX", destination: "Archive" });
  assert.match(missing.text, /UIDs 999, 998 .*nothing was changed/);
  assert.equal(s.account.messages("INBOX").length, 3);

  const moved = await s.json("move_email", { uid: uids.slice(0, 2), folder: "INBOX", destination: "Archive" });
  assert.equal(moved.messages.length, 2);
  assert.equal("newUid" in moved, false);
  assert.equal(s.account.messages("Archive").length, 2);
  const deleted = await s.json("delete_email", { uid: moved.messages.map((m: any) => m.newUid), folder: "Archive" });
  assert.equal(deleted.movedTo, "Trash");
  assert.equal(s.account.messages("Trash").length, 2);
});

test("drafts can come from another of your addresses, and replies come from the one written to", async () => {
  const s = await setup({ addresses: "alias@pm.me" });
  const draft = await s.json("create_draft", { from: "Alias@pm.me", to: "anna@example.org", subject: "s", body: "b" });
  assert.equal(draft.from, "alias@pm.me");
  const refused = await s.call("create_draft", { from: "boss@example.org", to: "anna@example.org", subject: "s", body: "b" });
  assert.match(refused.text, /not one of your addresses/);

  const uid = await addMail(s.account, "INBOX", { from: "anna@example.org", to: "alias@pm.me", cc: SELF, subject: "Hi", text: "x" });
  const reply = await s.json("create_reply_draft", { uid, folder: "INBOX", body: "Hi", replyAll: true });
  assert.equal(reply.from, "alias@pm.me");
  assert.equal(reply.to, "anna@example.org");
  assert.equal(reply.cc, undefined);
  assert.equal(s.account.messages("Drafts").length, 2);
});

test("attachments over Proton's total limit are refused before anything is saved", async () => {
  const big = "x".repeat(13 * 1024 * 1024);
  const s = await setup({ files: { "/Users/me/Documents/a.bin": big, "/Users/me/Documents/b.bin": big } });
  const result = await s.call("create_draft", { to: "a@example.org", subject: "s", body: "b", attachments: ["/Users/me/Documents/a.bin", "/Users/me/Documents/b.bin"] });
  assert.match(result.text, /over Proton Mail's limit/);
  assert.equal(s.account.messages("Drafts").length, 0);
});
