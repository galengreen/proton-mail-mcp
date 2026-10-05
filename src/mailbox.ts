import { simpleParser, type ParsedMail } from "mailparser";
import type { FetchMessageObject, ListTreeResponse, SearchObject } from "imapflow";
import type { MailClient } from "./imap/client.ts";
import type { ImapSession } from "./imap/session.ts";

/** Proton Bridge shows each label as a folder under this one. */
export const LABELS_ROOT = "Labels";

export interface Folder {
  path: string;
  name: string;
  specialUse: string | null;
}

export interface Summary {
  uid: number;
  date: string | null;
  from: string;
  subject: string;
  flags: string[];
}

export interface Page {
  folder: string;
  /** Messages in the folder, or matches for a search. */
  total: number;
  offset: number;
  messages: Summary[];
  /** Pass as `offset` to get the next, older page; null on the last page. */
  nextOffset: number | null;
}

export interface SearchCriteria {
  from?: string | undefined;
  to?: string | undefined;
  subject?: string | undefined;
  body?: string | undefined;
  /** YYYY-MM-DD, inclusive. */
  since?: string | undefined;
  /** YYYY-MM-DD, exclusive. */
  before?: string | undefined;
  unread?: boolean | undefined;
  flagged?: boolean | undefined;
}

export type FlagAction = "read" | "unread" | "flag" | "unflag";

export class NotFoundError extends Error {
  override name = "NotFoundError";
}

function notFound(uid: number, folder: string): NotFoundError {
  return new NotFoundError(
    `No message with UID ${uid} in "${folder}". It may have been moved or deleted; list or search the folder again for current UIDs.`
  );
}

function summarise(message: FetchMessageObject): Summary {
  const envelope = message.envelope;
  const sender = envelope?.from?.[0];
  const date = envelope?.date ? new Date(envelope.date) : null;
  return {
    uid: message.uid,
    date: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null,
    from: sender ? (sender.name ? `${sender.name} <${sender.address ?? ""}>` : (sender.address ?? "")) : "",
    subject: envelope?.subject || "(no subject)",
    flags: [...(message.flags ?? [])]
  };
}

function flatten(tree: ListTreeResponse, into: Folder[] = []): Folder[] {
  for (const node of tree.folders ?? []) {
    if (node.path) into.push({ path: node.path, name: node.name ?? node.path, specialUse: node.specialUse ?? null });
    flatten(node, into);
  }
  return into;
}

/** Mail operations, each run on the shared IMAP session. */
export class Mailbox {
  readonly #session: ImapSession;

  constructor(session: ImapSession) {
    this.#session = session;
  }

  folders(): Promise<Folder[]> {
    return this.#session.run(async (client) => flatten(await client.listTree()), "repeatable");
  }

  /** The newest messages first, `limit` at a time, skipping `offset`. */
  list(folder: string, limit: number, offset: number): Promise<Page> {
    return this.#session.run((client) => withFolder(client, folder, async () => {
      const total = client.mailbox ? client.mailbox.exists : 0;
      const last = total - offset;
      if (last < 1) return { folder, total, offset, messages: [], nextOffset: null };
      const first = Math.max(1, last - limit + 1);
      const messages: Summary[] = [];
      for await (const message of client.fetch(`${first}:${last}`, { uid: true, envelope: true, flags: true })) {
        messages.push(summarise(message));
      }
      messages.sort((a, b) => b.uid - a.uid);
      return { folder, total, offset, messages, nextOffset: first > 1 ? offset + messages.length : null };
    }), "repeatable");
  }

  search(folder: string, criteria: SearchCriteria, limit: number, offset: number): Promise<Page> {
    const query: SearchObject = {};
    if (criteria.from) query.from = criteria.from;
    if (criteria.to) query.to = criteria.to;
    if (criteria.subject) query.subject = criteria.subject;
    if (criteria.body) query.body = criteria.body;
    if (criteria.since) query.since = new Date(`${criteria.since}T00:00:00Z`);
    if (criteria.before) query.before = new Date(`${criteria.before}T00:00:00Z`);
    if (criteria.unread !== undefined) query.seen = !criteria.unread;
    if (criteria.flagged !== undefined) query.flagged = criteria.flagged;
    if (Object.keys(query).length === 0) query.all = true;

    return this.#session.run((client) => withFolder(client, folder, async () => {
      const uids = ((await client.search(query, { uid: true })) || []).sort((a, b) => a - b);
      const end = uids.length - offset;
      const pageUids = end > 0 ? uids.slice(Math.max(0, end - limit), end) : [];
      const messages: Summary[] = [];
      if (pageUids.length > 0) {
        for await (const message of client.fetch(pageUids, { uid: true, envelope: true, flags: true }, { uid: true })) {
          messages.push(summarise(message));
        }
      }
      messages.sort((a, b) => b.uid - a.uid);
      const more = end - pageUids.length > 0;
      return { folder, total: uids.length, offset, messages, nextOffset: more ? offset + pageUids.length : null };
    }), "repeatable");
  }

  read(folder: string, uid: number): Promise<ParsedMail> {
    return this.#session.run((client) => withFolder(client, folder, async () => {
      const message = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
      if (!message || !message.source) throw notFound(uid, folder);
      // keepCidLinks leaves inline images as cid: references instead of
      // expanding each one into the HTML as base64.
      return simpleParser(message.source, { keepCidLinks: true });
    }), "repeatable");
  }

  /** Store a message in Drafts. Runs at most once, so a timeout cannot leave two drafts. */
  saveDraft(raw: Buffer): Promise<{ folder: string; uid: number | null }> {
    return this.#session.run(async (client) => {
      const drafts = await specialFolder(client, "\\Drafts", "Drafts");
      const stored = await client.append(drafts, raw, ["\\Draft", "\\Seen"]);
      if (!stored) throw new Error(`Saving the draft to "${drafts}" failed.`);
      return { folder: drafts, uid: stored.uid ?? null };
    }, "once");
  }

  move(folder: string, uid: number, destination: string): Promise<{ destination: string; uid: number | null }> {
    return this.#session.run((client) => withFolder(client, folder, async () => {
      await requireMessage(client, folder, uid);
      const moved = await client.messageMove(String(uid), destination, { uid: true });
      if (!moved) throw new Error(`Moving UID ${uid} from "${folder}" to "${destination}" failed. Check the folder name with list_folders.`);
      return { destination: moved.destination, uid: moved.uidMap?.get(uid) ?? null };
    }), "once");
  }

  /** Move to Trash. Nothing is deleted permanently. */
  async trash(folder: string, uid: number): Promise<{ destination: string; uid: number | null }> {
    const trash = await this.#session.run((client) => specialFolder(client, "\\Trash", "Trash"), "repeatable");
    if (folder === trash) throw new Error("The message is already in Trash.");
    return this.move(folder, uid, trash);
  }

  setFlag(folder: string, uid: number, action: FlagAction): Promise<void> {
    const flag = action === "read" || action === "unread" ? "\\Seen" : "\\Flagged";
    const add = action === "read" || action === "flag";
    return this.#session.run((client) => withFolder(client, folder, async () => {
      await requireMessage(client, folder, uid);
      const ok = add
        ? await client.messageFlagsAdd(String(uid), [flag], { uid: true })
        : await client.messageFlagsRemove(String(uid), [flag], { uid: true });
      if (!ok) throw new Error(`Marking UID ${uid} in "${folder}" as ${action} failed.`);
    }), "repeatable");
  }

  /** Apply a Proton label. Bridge applies a label when a message is copied into its folder. */
  addLabel(folder: string, uid: number, label: string): Promise<string> {
    return this.#session.run(async (client) => {
      const path = await labelFolder(client, label);
      await withFolder(client, folder, async () => {
        await requireMessage(client, folder, uid);
        const copied = await client.messageCopy(String(uid), path, { uid: true });
        if (!copied) throw new Error(`Applying label "${label}" to UID ${uid} failed.`);
      });
      return path;
    }, "once");
  }

  /**
   * Remove a Proton label. Bridge removes the label, and only the label, when
   * a message is deleted from that label's folder; the message itself stays
   * in its folder. The copy in the label folder is found by Message-ID.
   */
  removeLabel(folder: string, uid: number, label: string): Promise<string> {
    return this.#session.run(async (client) => {
      const path = await labelFolder(client, label);
      const messageId = await withFolder(client, folder, async () => {
        const message = await client.fetchOne(String(uid), { uid: true, envelope: true }, { uid: true });
        if (!message) throw notFound(uid, folder);
        return message.envelope?.messageId;
      });
      if (!messageId) throw new Error(`UID ${uid} has no Message-ID, so its copy under "${path}" cannot be found.`);
      await withFolder(client, path, async () => {
        const candidates = (await client.search({ header: { "message-id": messageId } }, { uid: true })) || [];
        const matches: number[] = [];
        if (candidates.length > 0) {
          // A header search matches substrings; keep exact matches only.
          for await (const m of client.fetch(candidates, { uid: true, envelope: true }, { uid: true })) {
            if (m.envelope?.messageId === messageId) matches.push(m.uid);
          }
        }
        if (matches.length === 0) throw new Error(`The message does not have the label "${label}".`);
        // Never delete outside a label folder: elsewhere it would remove the message.
        if (!path.startsWith(`${LABELS_ROOT}/`)) throw new Error(`Refusing to delete from "${path}", which is not a label folder.`);
        const removed = await client.messageDelete(matches.join(","), { uid: true });
        if (!removed) throw new Error(`Removing label "${label}" failed.`);
      });
      return path;
    }, "once");
  }
}

async function withFolder<T>(client: MailClient, folder: string, action: () => Promise<T>): Promise<T> {
  const lock = await client.getMailboxLock(folder);
  try {
    return await action();
  } finally {
    lock.release();
  }
}

/**
 * UID MOVE, UID COPY and UID STORE all succeed quietly when the UID matches
 * nothing, which would be reported as success. Check first.
 */
async function requireMessage(client: MailClient, folder: string, uid: number): Promise<void> {
  const found = await client.search({ uid: String(uid) }, { uid: true });
  if (!found || !found.includes(uid)) throw notFound(uid, folder);
}

async function specialFolder(client: MailClient, use: string, fallback: string): Promise<string> {
  return flatten(await client.listTree()).find((f) => f.specialUse === use)?.path ?? fallback;
}

async function labelFolder(client: MailClient, label: string): Promise<string> {
  const name = label.replace(new RegExp(`^${LABELS_ROOT}/`), "");
  const path = `${LABELS_ROOT}/${name}`;
  const folders = flatten(await client.listTree());
  if (folders.some((f) => f.path === path)) return path;
  const labels = folders.filter((f) => f.path.startsWith(`${LABELS_ROOT}/`)).map((f) => f.path.slice(LABELS_ROOT.length + 1));
  throw new Error(
    `There is no label "${name}". ` +
    (labels.length ? `Labels: ${labels.join(", ")}.` : "This account has no labels.") +
    " Labels are created in Proton Mail itself."
  );
}
