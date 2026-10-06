import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { attachmentContent, describeAttachments, findAttachment } from "../attachments/index.ts";
import type { Mailbox } from "../mailbox.ts";
import { bodyFields, formatAddresses, messageBody } from "../message.ts";
import { READS, folder, isoDate, json, limit, messageFolder, offset, uid } from "./shared.ts";

export function registerReadingTools(server: McpServer, mailbox: Mailbox): void {
  server.registerTool("list_folders", {
    title: "List folders",
    description: "List every folder, including system folders (INBOX, Sent, Drafts, Archive, Spam, Trash), your own folders under Folders/ and your labels under Labels/, with how many messages each holds and how many are unread.",
    annotations: READS
  }, async () => json(await mailbox.folders()));

  server.registerTool("list_emails", {
    title: "List emails",
    description: "List the messages in a folder, newest first, with UID, date, sender, recipients, subject, flags, size and whether there are attachments. Page through older messages with offset; the response gives the nextOffset to use, or null on the last page. UIDs belong to this folder: pass the same folder to any tool that uses them.",
    inputSchema: z.object({ folder: folder(), limit, offset }),
    annotations: READS
  }, async (args) => json(await mailbox.list(args.folder, args.limit, args.offset)));

  server.registerTool("search_emails", {
    title: "Search emails",
    description: "Search a folder by sender, recipient, subject, body text, date range, read state or flag. Every filter given must match. Returns message summaries newest first, paged like list_emails. To search everywhere, use the folder \"All Mail\"; the UIDs found are then All Mail's, so pass folder \"All Mail\" to the tools that use them.",
    inputSchema: z.object({
      folder: folder(),
      from: z.string().optional().describe("Text in the sender's name or address"),
      to: z.string().optional().describe("Text in a recipient's name or address"),
      subject: z.string().optional().describe("Text in the subject"),
      body: z.string().optional().describe("Text in the message body"),
      since: isoDate("Only messages received on or after this date, YYYY-MM-DD").optional(),
      before: isoDate("Only messages received before this date, YYYY-MM-DD").optional(),
      unread: z.boolean().optional().describe("true for unread messages only, false for read ones only"),
      flagged: z.boolean().optional().describe("true for flagged (starred) messages only, false for unflagged ones only"),
      limit,
      offset
    }),
    annotations: READS
  }, async ({ folder: path, limit: count, offset: skip, ...criteria }) => json(await mailbox.search(path, criteria, count, skip)));

  server.registerTool("read_email", {
    title: "Read email",
    description:
      "Read one message: its headers, its text and its attachments. " +
      "The text comes from the plain-text part, or is converted from the HTML part when there is no usable plain text; bodySource says which ('plain', 'html' or 'none'). Text over 100 kB is cut off and marked truncated. " +
      "The raw HTML is left out unless includeHtml is true, since it mostly repeats the text at many times the size; hasHtml says whether there is any. " +
      "Attachments are listed with index, filename, type and size. Text attachments and calendar invites up to 64 kB are included, invites also as a parsed calendar (method, and each event's time, place, organiser and attendees). PDFs include the text of their text layer (up to 64 kB); a scanned PDF has none and says so. At most 256 kB of attachment text is included in all; any further attachments are listed with a note. " +
      "For invites, bookings and invoices the details are often in the attachments rather than the text, so check them. Use read_attachment for images and for anything too large to include.",
    inputSchema: z.object({
      uid: uid(),
      folder: messageFolder(),
      includeHtml: z.boolean().default(false).describe("Also return the raw HTML, for its links or layout")
    }),
    annotations: READS
  }, async (args) => {
    const mail = await mailbox.read(args.folder, args.uid);
    return json({
      uid: args.uid,
      folder: args.folder,
      subject: mail.subject ?? "(no subject)",
      date: mail.date?.toISOString() ?? null,
      from: formatAddresses(mail.from),
      replyTo: formatAddresses(mail.replyTo) || null,
      to: formatAddresses(mail.to),
      cc: formatAddresses(mail.cc) || null,
      // Only drafts and sent mail carry Bcc.
      bcc: formatAddresses(mail.bcc) || null,
      messageId: mail.messageId ?? null,
      inReplyTo: mail.inReplyTo ?? null,
      ...bodyFields(messageBody(mail), args.includeHtml),
      attachments: await describeAttachments(mail.attachments)
    });
  });

  server.registerTool("read_attachment", {
    title: "Read attachment",
    description:
      "Read one attachment of a message, chosen by the index or filename that read_email lists. " +
      "PNG, JPEG, GIF and WebP images come back as an image you can look at, which is how to read a scanned invoice or a photo of a ticket; other image types, such as HEIC, come back as files. PDFs come back as their text, page by page. Text files and calendar invites come back as text, invites also parsed. Other files come back as base64. " +
      "Limits: 1 MB of text, 8 MB PDFs, 4 MB images, 1 MB other files; anything larger comes back as a description with a note.",
    inputSchema: z.object({
      uid: uid(),
      folder: messageFolder(),
      index: z.number().int().min(0).optional().describe("Index of the attachment in read_email's list; used if both are given"),
      filename: z.string().min(1).optional().describe("Filename of the attachment, ignoring case")
    }),
    annotations: READS
  }, async (args) => {
    const mail = await mailbox.read(args.folder, args.uid);
    const { attachment, index } = findAttachment(mail.attachments, args);
    return { content: await attachmentContent(attachment, index) };
  });
}
