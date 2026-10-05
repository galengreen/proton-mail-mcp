import type { Attachment } from "mailparser";
import { htmlToText, truncateUtf8 } from "../text.ts";
import { parseCalendar, type Calendar } from "./calendar.ts";
import { readPdfText } from "./pdf.ts";

/** Sizes above which content is left out. */
export interface Limits {
  /** Text inlined in a read_email listing. */
  inlineText: number;
  /** Text returned by read_attachment, including PDF text. */
  fullText: number;
  /** Largest PDF whose text is extracted. */
  pdfFile: number;
  /** Largest image returned for viewing. */
  image: number;
  /** Largest other file returned as base64. */
  binary: number;
}

export const LIMITS: Limits = {
  inlineText: 64 * 1024,
  fullText: 1024 * 1024,
  pdfFile: 8 * 1024 * 1024,
  image: 4 * 1024 * 1024,
  binary: 1024 * 1024
};

export interface AttachmentInfo {
  index: number;
  filename: string | null;
  contentType: string;
  size: number;
  inline: boolean;
  cid: string | null;
  content?: string | null;
  truncated?: true;
  calendar?: Calendar;
  pages?: number;
  pdfInfo?: Record<string, string>;
  contentBase64?: string;
  note?: string;
}

type Kind = "calendar" | "text" | "pdf" | "image" | "binary";

export function kindOf(attachment: Pick<Attachment, "contentType" | "filename">): Kind {
  const type = attachment.contentType.toLowerCase();
  if (type === "text/calendar" || type === "application/ics") return "calendar";
  if (type.startsWith("text/")) return "text";
  if (type === "application/pdf" || type === "application/x-pdf") return "pdf";
  // PDFs are often sent as a generic binary; the name gives them away.
  if (type === "application/octet-stream" && /\.pdf$/i.test(attachment.filename ?? "")) return "pdf";
  if (type.startsWith("image/")) return "image";
  return "binary";
}

/** Decode text in its declared charset, falling back to UTF-8 for unknown ones. */
export function decodeText(attachment: Pick<Attachment, "content" | "contentType" | "headers">): string {
  const contentType = attachment.headers?.get("content-type") as { params?: { charset?: string } } | undefined;
  const charset = contentType?.params?.charset ?? "utf-8";
  let text: string;
  try {
    text = new TextDecoder(charset).decode(attachment.content);
  } catch {
    // An unknown charset label; UTF-8 is the best guess.
    text = new TextDecoder("utf-8").decode(attachment.content);
  }
  return attachment.contentType.toLowerCase() === "text/html" ? htmlToText(text) : text;
}

function baseInfo(attachment: Attachment, index: number): AttachmentInfo {
  return {
    index,
    filename: attachment.filename ?? null,
    contentType: attachment.contentType,
    size: attachment.size ?? attachment.content.length,
    inline: attachment.contentDisposition === "inline",
    cid: attachment.cid ?? null
  };
}

function withText(info: AttachmentInfo, attachment: Attachment, maxBytes: number): AttachmentInfo {
  const decoded = decodeText(attachment);
  const { text, truncated } = truncateUtf8(decoded, maxBytes);
  const result: AttachmentInfo = { ...info, content: text };
  if (truncated) result.truncated = true;
  if (kindOf(attachment) === "calendar") {
    // Parse the whole invite, not the truncated text, so no event is lost.
    const calendar = parseCalendar(decoded);
    if (calendar) {
      if (!calendar.method) {
        const header = attachment.headers?.get("content-type") as { params?: { method?: string } } | undefined;
        calendar.method = header?.params?.method?.toUpperCase() ?? null;
      }
      result.calendar = calendar;
    }
  }
  return result;
}

async function withPdfText(info: AttachmentInfo, attachment: Attachment, limits: Limits, maxText: number): Promise<AttachmentInfo> {
  if (info.size > limits.pdfFile) {
    return { ...info, content: null, note: `Text not extracted: the PDF is ${info.size} bytes, over the ${limits.pdfFile} byte limit.` };
  }
  try {
    const pdf = await readPdfText(attachment.content);
    const result: AttachmentInfo = { ...info, pages: pdf.pages, pdfInfo: pdf.info };
    if (pdf.text === "") {
      return { ...result, content: null, note: "The PDF has no text layer, so it is probably a scanned image; its text cannot be read." };
    }
    const { text, truncated } = truncateUtf8(pdf.text, maxText);
    result.content = text;
    if (truncated) result.truncated = true;
    if (pdf.pagesRead < pdf.pages) result.note = `Only the first ${pdf.pagesRead} of ${pdf.pages} pages were read.`;
    return result;
  } catch (error) {
    // One unreadable attachment must not fail the whole message.
    return { ...info, content: null, note: `Text not extracted: ${error instanceof Error ? error.message : String(error)}.` };
  }
}

/**
 * Describe every attachment for read_email. Text, calendar invites and the
 * text of PDFs are included when small enough, because that is often where
 * the facts are: the time of an appointment, the amount on an invoice.
 */
export async function describeAttachments(attachments: Attachment[], limits: Limits = LIMITS): Promise<AttachmentInfo[]> {
  return Promise.all(attachments.map(async (attachment, index) => {
    const info = baseInfo(attachment, index);
    switch (kindOf(attachment)) {
      case "pdf":
        return withPdfText(info, attachment, limits, limits.inlineText);
      case "calendar":
      case "text":
        if (info.size > limits.inlineText) {
          return { ...info, content: null, note: `Not shown: ${info.size} bytes. Use read_attachment to read it.` };
        }
        return withText(info, attachment, limits.inlineText);
      default:
        return info;
    }
  }));
}

/** Find an attachment by index or, failing that, by filename (ignoring case). */
export function findAttachment(attachments: Attachment[], selector: { index?: number | undefined; filename?: string | undefined }): { attachment: Attachment; index: number } {
  let index = -1;
  if (selector.index !== undefined) {
    index = selector.index < attachments.length ? selector.index : -1;
  } else if (selector.filename) {
    const wanted = selector.filename.toLowerCase();
    index = attachments.findIndex((a) => a.filename?.toLowerCase() === wanted);
  } else {
    throw new Error("Give the index or the filename of the attachment.");
  }
  const attachment = attachments[index];
  if (attachment) return { attachment, index };
  const available = attachments.length === 0
    ? "The message has no attachments."
    : `Attachments: ${attachments.map((a, i) => `${i}: ${a.filename ?? "(no name)"} (${a.contentType})`).join("; ")}.`;
  const wanted = selector.index !== undefined ? `index ${selector.index}` : `filename "${selector.filename}"`;
  throw new Error(`No attachment with ${wanted}. ${available}`);
}

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/**
 * One attachment in full, for read_attachment. Images come back as an image
 * the model can look at, PDFs as their text, other files as base64.
 */
export async function attachmentContent(attachment: Attachment, index: number, limits: Limits = LIMITS): Promise<ToolContent[]> {
  const info = baseInfo(attachment, index);
  const json = (value: AttachmentInfo): ToolContent => ({ type: "text", text: JSON.stringify(value, null, 2) });
  switch (kindOf(attachment)) {
    case "pdf":
      // A PDF's bytes are of no use to a model; its text is.
      return [json(await withPdfText(info, attachment, limits, limits.fullText))];
    case "calendar":
    case "text":
      return [json(withText(info, attachment, limits.fullText))];
    case "image":
      if (info.size > limits.image) {
        return [json({ ...info, note: `Not returned: the image is ${info.size} bytes, over the ${limits.image} byte limit.` })];
      }
      return [json(info), { type: "image", data: attachment.content.toString("base64"), mimeType: attachment.contentType }];
    default:
      if (info.size > limits.binary) {
        return [json({ ...info, note: `Not returned: the file is ${info.size} bytes, over the ${limits.binary} byte limit.` })];
      }
      return [json({ ...info, contentBase64: attachment.content.toString("base64") })];
  }
}
