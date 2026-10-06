import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ParsedMail } from "mailparser";
import { buildMessage, mailOptions, type Draft } from "../compose.ts";
import type { Config } from "../config.ts";
import { MAX_ATTACHMENT_BYTES, type LocalFile } from "../files.ts";
import type { Mailbox } from "../mailbox.ts";
import { quotedReply, replyFrom, replyRecipients, replySubject, threadingHeaders } from "../message.ts";
import type { SmtpSender } from "../smtp.ts";
import { SENDS_MAIL, WRITES_DRAFT, addresses, attachmentPaths, json, messageFolder, uid } from "./shared.ts";

export interface WritingDeps {
  config: Config;
  mailbox: Mailbox;
  /** Present only when sending is allowed. */
  sender: SmtpSender | null;
  readFile: (path: string) => Promise<LocalFile>;
}

const from = z.string().min(1).optional()
  .describe("Which of your addresses to send from; by default the main one. Others must be listed in PROTON_BRIDGE_ADDRESSES");

const newMessage = z.object({
  from,
  to: addresses("Recipients, comma-separated, e.g. \"Anna <anna@example.com>, bob@example.com\""),
  cc: z.string().optional().describe("Cc recipients, comma-separated"),
  bcc: z.string().optional().describe("Bcc recipients, comma-separated"),
  subject: z.string().describe("Subject line"),
  body: z.string().describe("The message as plain text"),
  html: z.string().optional().describe("Optional HTML version of the message"),
  attachments: attachmentPaths
});

const reply = z.object({
  uid: uid("UID of the message being replied to"),
  folder: messageFolder("Folder the message being replied to is in"),
  body: z.string().describe("The reply as plain text, without the quoted original"),
  html: z.string().optional().describe("Optional HTML version of the reply"),
  replyAll: z.boolean().default(false).describe("Also reply to everyone else on To and Cc, who go on Cc"),
  quote: z.boolean().default(true).describe("Quote the original message below the reply, as mail clients do"),
  attachments: attachmentPaths
});

type NewMessageArgs = { from?: string | undefined; to: string; cc?: string | undefined; bcc?: string | undefined; subject: string; body: string; html?: string | undefined; attachments?: string[] | undefined };
type ReplyArgs = { uid: number; folder: string; body: string; html?: string | undefined; replyAll: boolean; quote: boolean; attachments?: string[] | undefined };

/**
 * Read the files to attach, one at a time, stopping as soon as together
 * they pass Proton's limit for one message rather than holding them all.
 */
async function readFiles(deps: WritingDeps, paths: string[] | undefined): Promise<LocalFile[]> {
  const files: LocalFile[] = [];
  let total = 0;
  for (const path of paths ?? []) {
    const file = await deps.readFile(path);
    total += file.content.length;
    if (total > MAX_ATTACHMENT_BYTES) {
      throw new Error(`The attachments come to more than ${MAX_ATTACHMENT_BYTES} bytes, which is over Proton Mail's limit for one message.`);
    }
    files.push(file);
  }
  return files;
}

/** The From address: the one asked for, which must be one of the account's, or the main one. */
function sendingAddress(config: Config, requested: string | undefined): string {
  if (requested === undefined) return config.username;
  const match = config.addresses.find((address) => address.toLowerCase() === requested.trim().toLowerCase());
  if (match) return match;
  throw new Error(
    `${requested} is not one of your addresses (${config.addresses.join(", ")}). ` +
    "Add other addresses of this account to PROTON_BRIDGE_ADDRESSES to send from them."
  );
}

async function newDraft(deps: WritingDeps, args: NewMessageArgs): Promise<Draft> {
  return {
    from: sendingAddress(deps.config, args.from),
    to: args.to,
    cc: args.cc,
    bcc: args.bcc,
    subject: args.subject,
    text: args.body,
    html: args.html,
    attachments: await readFiles(deps, args.attachments)
  };
}

async function replyDraft(deps: WritingDeps, args: ReplyArgs): Promise<{ draft: Draft; original: ParsedMail }> {
  const original = await deps.mailbox.read(args.folder, args.uid);
  const recipients = replyRecipients(original, deps.config.addresses, args.replyAll);
  const content = args.quote
    ? quotedReply({ text: args.body, ...(args.html !== undefined && { html: args.html }) }, original)
    : { text: args.body, html: args.html };
  return {
    original,
    draft: {
      from: replyFrom(original, deps.config.addresses),
      to: recipients.to,
      cc: recipients.cc,
      subject: replySubject(original.subject),
      text: content.text,
      html: content.html,
      ...threadingHeaders(original),
      attachments: await readFiles(deps, args.attachments)
    }
  };
}

function describe(draft: Draft) {
  return {
    from: draft.from,
    to: draft.to,
    ...(draft.cc && { cc: draft.cc }),
    ...(draft.bcc && { bcc: draft.bcc }),
    subject: draft.subject,
    attachments: (draft.attachments ?? []).map((file) => file.filename)
  };
}

export function registerWritingTools(server: McpServer, deps: WritingDeps): void {
  server.registerTool("create_draft", {
    title: "Create draft",
    description: "Write a new email and save it in Drafts. Nothing is sent: the user reviews and sends it from Proton Mail.",
    inputSchema: newMessage,
    annotations: WRITES_DRAFT
  }, async (args) => {
    const draft = await newDraft(deps, args);
    const saved = await deps.mailbox.saveDraft(await buildMessage(draft));
    return json({ saved: true, folder: saved.folder, uid: saved.uid, ...describe(draft) });
  });

  server.registerTool("create_reply_draft", {
    title: "Create reply draft",
    description:
      "Write a reply to a message and save it in Drafts, threaded with the original. It is sent from the address of yours the original was sent to. It goes to the sender's Reply-To address if they set one, otherwise to the sender; replying to your own message goes to its recipients. The original is quoted below the reply unless quote is false. Nothing is sent: the user reviews and sends it from Proton Mail. Note that Proton Mail Bridge does not keep threading headers on drafts, so the draft has the Re: subject and the quote but may not be grouped with the original conversation.",
    inputSchema: reply,
    annotations: WRITES_DRAFT
  }, async (args) => {
    const { draft, original } = await replyDraft(deps, args);
    const saved = await deps.mailbox.saveDraft(await buildMessage(draft));
    return json({ saved: true, folder: saved.folder, uid: saved.uid, inReplyTo: original.messageId ?? null, ...describe(draft) });
  });

  const sender = deps.sender;
  if (!sender) return;

  server.registerTool("send_email", {
    title: "Send email",
    description: "Send a new email straight away. It cannot be unsent. Prefer create_draft unless the user has asked for the message to be sent.",
    inputSchema: newMessage,
    annotations: SENDS_MAIL
  }, async (args) => {
    const draft = await newDraft(deps, args);
    const info = await sender.send(mailOptions(draft));
    return json({ sent: true, messageId: info.messageId ?? null, ...describe(draft) });
  });

  server.registerTool("reply_to_email", {
    title: "Reply to email",
    description:
      "Send a reply straight away, threaded with the original and addressed as create_reply_draft does. It cannot be unsent. Prefer create_reply_draft unless the user has asked for the reply to be sent.",
    inputSchema: reply,
    annotations: SENDS_MAIL
  }, async (args) => {
    const { draft, original } = await replyDraft(deps, args);
    const info = await sender.send(mailOptions(draft));
    return json({ sent: true, messageId: info.messageId ?? null, inReplyTo: original.messageId ?? null, ...describe(draft) });
  });
}
