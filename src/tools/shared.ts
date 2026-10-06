import { z } from "zod";
import type { ToolAnnotations } from "@modelcontextprotocol/server";

export const folder = (what = "Folder path, e.g. INBOX, Archive or Folders/Receipts (see list_folders)") =>
  z.string().min(1).default("INBOX").describe(what);

/**
 * The folder a UID belongs to. Required, with no default: UIDs are numbered
 * per folder, so a UID found in Archive or All Mail names a different
 * message in INBOX, and guessing the folder would act on the wrong one.
 */
export const messageFolder = (what = "Folder the message is in, exactly as list_emails or search_emails was given it") =>
  z.string().min(1).describe(`${what}. UIDs are numbered per folder, so this must be the folder the UID came from`);

export const uid = (what = "UID of the message, as given by list_emails or search_emails") =>
  z.number().int().positive().describe(what);

export const MAX_UIDS = 100;

/** One UID, or several in the same folder to change together. */
export const uids = (what = "UID of the message, or a list of up to 100 UIDs in the same folder, as given by list_emails or search_emails") =>
  z.union([z.number().int().positive(), z.array(z.number().int().positive()).min(1).max(MAX_UIDS)]).describe(what);

/** The UIDs as a list, each once. */
export function uidList(value: number | number[]): number[] {
  return [...new Set(Array.isArray(value) ? value : [value])];
}

export const limit = z.number().int().min(1).max(50).default(20).describe("How many messages to return, 1 to 50");

export const offset = z.number().int().min(0).default(0)
  .describe("How many of the newest messages to skip; use nextOffset from the previous page");

export const isoDate = (what: string) => z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the format YYYY-MM-DD")
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
  }, "Not a real date")
  .describe(what);

export const addresses = (what: string) => z.string().min(1).describe(what);

export const attachmentPaths = z.array(z.string().min(1)).max(20).optional()
  .describe("Paths of local files to attach. Only files in the folders allowed by PROTON_BRIDGE_ATTACHMENT_DIRS (by default Documents, Downloads and Desktop) can be attached");

/** Hints that let a client tell reading apart from changing mail. */
export const READS: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
export const WRITES_DRAFT: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
export const CHANGES_MAIL: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const REMOVES_MAIL: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
/** Sending reaches other people and cannot be undone. */
export const SENDS_MAIL: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

/** A tool result as compact JSON: indenting adds tokens and nothing a model needs. */
export function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}
