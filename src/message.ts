import type { AddressObject, EmailAddress, ParsedMail } from "mailparser";
import { escapeHtml, htmlToText, isBlank, quoteLines, stripLargeDataUris, truncateUtf8 } from "./text.ts";

export const MAX_BODY_BYTES = 100 * 1024;

export type BodySource = "plain" | "html" | "none";

export interface Body {
  text: string;
  html: string | null;
  source: BodySource;
}

/**
 * The readable text of a message. The text/plain part is used when it has
 * any content. Otherwise the HTML part is converted, which matters because
 * mailparser leaves `text` empty for HTML inside a multipart/related or
 * multipart/mixed part, that is, for any message with images or attachments.
 */
export function messageBody(mail: Pick<ParsedMail, "text" | "html">): Body {
  const html = typeof mail.html === "string" && mail.html !== "" ? mail.html : null;
  if (!isBlank(mail.text)) return { text: mail.text ?? "", html, source: "plain" };
  if (html !== null) {
    const converted = htmlToText(html);
    if (!isBlank(converted)) return { text: converted, html, source: "html" };
    return { text: "[The HTML part has no text, only images or layout.]", html, source: "none" };
  }
  return { text: "[This message has no text or HTML part.]", html: null, source: "none" };
}

export interface BodyFields {
  text: string;
  bodySource: BodySource;
  hasHtml?: boolean;
  html?: string | null;
  truncated?: true;
  htmlTruncated?: true;
  note?: string;
}

/**
 * The body as read_email reports it. HTML is included only on request: for
 * most mail it repeats the text at many times the size.
 */
export function bodyFields(body: Body, includeHtml: boolean, maxBytes = MAX_BODY_BYTES): BodyFields {
  const text = truncateUtf8(body.text, maxBytes);
  const fields: BodyFields = { text: text.text, bodySource: body.source };
  if (text.truncated) {
    fields.truncated = true;
    fields.note = `The body is ${Buffer.byteLength(body.text)} bytes; only the first ${maxBytes} are shown.`;
  }
  if (!includeHtml) {
    fields.hasHtml = body.html !== null;
  } else if (body.html === null) {
    fields.html = null;
  } else {
    const html = truncateUtf8(stripLargeDataUris(body.html), maxBytes);
    fields.html = html.text;
    if (html.truncated) fields.htmlTruncated = true;
  }
  return fields;
}

// --- Addresses -------------------------------------------------------------

type AddressField = AddressObject | AddressObject[] | undefined;

/** Flatten a mailparser address field, including members of groups. */
export function addressList(field: AddressField): EmailAddress[] {
  const objects = Array.isArray(field) ? field : field ? [field] : [];
  const out: EmailAddress[] = [];
  const visit = (entry: EmailAddress) => {
    if (entry.group) entry.group.forEach(visit);
    else if (entry.address) out.push(entry);
  };
  objects.forEach((object) => object.value.forEach(visit));
  return out;
}

export function formatAddress(entry: { name?: string; address?: string }): string {
  const address = entry.address ?? "";
  if (!entry.name) return address;
  return `"${entry.name.replace(/(["\\])/g, "\\$1")}" <${address}>`;
}

export function formatAddresses(field: AddressField): string {
  return addressList(field).map(formatAddress).join(", ");
}

// --- Replies ---------------------------------------------------------------

/** "Re: " in front of a subject, unless it is already a reply in any form. */
export function replySubject(subject: string | undefined): string {
  const s = subject?.trim() ?? "";
  return /^(re|aw|sv)(\[\d+\])?\s*:/i.test(s) ? s : `Re: ${s}`;
}

export interface ReplyRecipients {
  to: string;
  cc?: string;
}

/**
 * Who a reply is addressed to, following what mail clients do:
 * - the Reply-To address when the sender set one, otherwise From;
 * - for a message you sent yourself, its original To recipients;
 * - with reply-all, everyone else on To and Cc goes on Cc, minus yourself
 *   and anyone already included.
 */
export function replyRecipients(mail: Pick<ParsedMail, "from" | "replyTo" | "to" | "cc">, self: string, replyAll: boolean): ReplyRecipients {
  const me = self.toLowerCase();
  const isMe = (entry: EmailAddress) => entry.address?.toLowerCase() === me;

  let primary = addressList(mail.replyTo);
  if (primary.length === 0) primary = addressList(mail.from);
  const sentByMe = primary.length > 0 && primary.every(isMe);
  if (sentByMe) primary = addressList(mail.to);

  const seen = new Set<string>([me]);
  const fresh = (entry: EmailAddress) => {
    const key = entry.address?.toLowerCase() ?? "";
    if (key === "" || seen.has(key)) return false;
    seen.add(key);
    return true;
  };

  let to = primary.filter(fresh);
  // Writing to yourself: nobody else is left, so reply to yourself.
  if (to.length === 0) to = primary.slice(0, 1);
  const result: ReplyRecipients = { to: to.map(formatAddress).join(", ") };
  if (replyAll) {
    const others = sentByMe ? addressList(mail.cc) : [...addressList(mail.to), ...addressList(mail.cc)];
    const cc = others.filter(fresh);
    if (cc.length > 0) result.cc = cc.map(formatAddress).join(", ");
  }
  return result;
}

export function threadingHeaders(mail: Pick<ParsedMail, "messageId" | "references">): { inReplyTo?: string; references?: string[] } {
  if (!mail.messageId) return {};
  const earlier = Array.isArray(mail.references) ? mail.references : mail.references ? [mail.references] : [];
  return { inReplyTo: mail.messageId, references: [...earlier, mail.messageId] };
}

/** The "On <date>, <sender> wrote:" line above a quoted reply. */
export function attribution(mail: Pick<ParsedMail, "date" | "from">): string {
  const sender = addressList(mail.from)[0];
  const who = sender ? (sender.name || sender.address) : "the sender";
  const when = mail.date ? mail.date.toUTCString() : null;
  return when ? `On ${when}, ${who} wrote:` : `${who} wrote:`;
}

export interface ReplyBody {
  text: string;
  html?: string;
}

/**
 * Put the original message below the reply, quoted. The quote comes from
 * the original's text (converted from HTML when that is all it has), so it
 * never carries the sender's markup or tracking images into the draft.
 */
export function quotedReply(reply: ReplyBody, original: Pick<ParsedMail, "date" | "from" | "text" | "html">, maxQuoteBytes = MAX_BODY_BYTES): ReplyBody {
  const body = messageBody(original);
  if (body.source === "none") return reply;
  const quoted = truncateUtf8(body.text.trimEnd(), maxQuoteBytes);
  const quotedText = quoted.text + (quoted.truncated ? "\n[...]" : "");
  const intro = attribution(original);
  const text = `${reply.text.trimEnd()}\n\n${intro}\n${quoteLines(quotedText)}\n`;
  if (reply.html === undefined) return { text };
  const html =
    `${reply.html}\n<br>\n<div>${escapeHtml(intro)}</div>\n` +
    `<blockquote type="cite" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">` +
    `${escapeHtml(quotedText).replace(/\r?\n/g, "<br>\n")}</blockquote>`;
  return { text, html };
}
