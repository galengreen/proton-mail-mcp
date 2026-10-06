import { EventEmitter } from "node:events";
import { simpleParser } from "mailparser";
import type { FetchMessageObject, FetchQueryObject, ListOptions, ListResponse, ListTreeResponse, MessageStructureObject, SearchObject } from "imapflow";
import type { MailClient } from "../../src/imap/client.ts";

interface StoredMessage {
  uid: number;
  raw: Buffer;
  flags: Set<string>;
}

interface StoredFolder {
  specialUse: string | null;
  uidNext: number;
  messages: StoredMessage[];
}

/**
 * An in-memory IMAP account that behaves like Proton Mail Bridge for the
 * commands this server uses: UIDs per folder, MOVE and COPY assign new UIDs,
 * UID commands on missing messages succeed without doing anything, and a
 * label is a folder under Labels/.
 */
export class FakeAccount {
  readonly folders = new Map<string, StoredFolder>();

  constructor(paths: Record<string, string | null> = {
    INBOX: "\\Inbox",
    Drafts: "\\Drafts",
    Sent: "\\Sent",
    Archive: "\\Archive",
    Trash: "\\Trash",
    "All Mail": "\\All",
    Folders: null,
    Labels: null
  }) {
    for (const [path, use] of Object.entries(paths)) this.addFolder(path, use);
  }

  addFolder(path: string, specialUse: string | null = null): void {
    this.folders.set(path, { specialUse, uidNext: 1, messages: [] });
  }

  add(path: string, raw: Buffer | string, flags: string[] = []): number {
    const folder = this.folder(path);
    const uid = folder.uidNext++;
    folder.messages.push({ uid, raw: Buffer.from(raw), flags: new Set(flags) });
    return uid;
  }

  folder(path: string): StoredFolder {
    const folder = this.folders.get(path);
    if (!folder) throw new Error(`Mailbox doesn't exist: ${path}`);
    return folder;
  }

  messages(path: string): StoredMessage[] {
    return this.folder(path).messages;
  }

  client(): FakeClient {
    return new FakeClient(this);
  }
}

function parseRange(range: string | number[], messages: StoredMessage[], byUid: boolean): StoredMessage[] {
  if (Array.isArray(range)) return messages.filter((m) => range.includes(m.uid));
  const picked = new Set<StoredMessage>();
  for (const part of range.split(",")) {
    const [a = "", b] = part.split(":");
    const resolve = (v: string) => (v === "*" ? Infinity : Number(v));
    const lo = resolve(a);
    const hi = b === undefined ? lo : resolve(b);
    messages.forEach((m, i) => {
      const key = byUid ? m.uid : i + 1;
      if (key >= Math.min(lo, hi) && key <= Math.max(lo, hi)) picked.add(m);
    });
  }
  return messages.filter((m) => picked.has(m));
}

export class FakeClient extends EventEmitter implements MailClient {
  usable = false;
  mailbox: { exists: number; path: string } | false = false;
  /** Every command issued, for assertions about what was (not) sent. */
  readonly log: string[] = [];
  /** Make the next call to this command fail with this error. */
  failNext = new Map<string, Error>();
  readonly #account: FakeAccount;

  constructor(account: FakeAccount) {
    super();
    this.#account = account;
  }

  #step(command: string): void {
    this.log.push(command);
    const failure = this.failNext.get(command);
    if (failure) {
      this.failNext.delete(command);
      throw failure;
    }
    if (!this.usable && command !== "connect") throw new Error("Connection not available");
  }

  #selected(): StoredFolder {
    if (!this.mailbox) throw new Error("No mailbox selected");
    return this.#account.folder(this.mailbox.path);
  }

  async connect(): Promise<void> {
    this.#step("connect");
    this.usable = true;
  }

  async logout(): Promise<void> {
    this.close();
  }

  close(): void {
    if (!this.usable) return;
    this.usable = false;
    this.emit("close");
  }

  async noop(): Promise<void> {
    this.#step("noop");
  }

  async list(options: ListOptions = {}): Promise<ListResponse[]> {
    this.#step("list");
    return [...this.#account.folders].map(([path, folder]) => {
      const parts = path.split("/");
      const entry: ListResponse = {
        path, pathAsListed: path, name: parts[parts.length - 1] ?? path, delimiter: "/",
        parent: parts.slice(0, -1), parentPath: parts.slice(0, -1).join("/"),
        flags: new Set(), listed: true, subscribed: true
      };
      if (folder.specialUse) entry.specialUse = folder.specialUse;
      if (options.statusQuery) {
        entry.status = { path, messages: folder.messages.length, unseen: folder.messages.filter((m) => !m.flags.has("\\Seen")).length };
      }
      return entry;
    });
  }

  async listTree(): Promise<ListTreeResponse> {
    this.#step("listTree");
    const root: ListTreeResponse = { root: true, folders: [] };
    const nodes = new Map<string, ListTreeResponse>();
    for (const [path, folder] of this.#account.folders) {
      const parts = path.split("/");
      const node: ListTreeResponse = { path, name: parts[parts.length - 1] ?? path, delimiter: "/", folders: [] };
      if (folder.specialUse) node.specialUse = folder.specialUse;
      nodes.set(path, node);
      const parent = parts.length > 1 ? nodes.get(parts.slice(0, -1).join("/")) : root;
      (parent ?? root).folders!.push(node);
    }
    return root;
  }

  async getMailboxLock(path: string): Promise<{ release(): void }> {
    this.#step("lock");
    const folder = this.#account.folder(path);
    this.mailbox = { exists: folder.messages.length, path };
    return { release: () => {} };
  }

  async *fetch(range: string | number[], query: FetchQueryObject, options: { uid?: boolean } = {}): AsyncGenerator<FetchMessageObject> {
    this.#step("fetch");
    const folder = this.#selected();
    for (const message of parseRange(range, folder.messages, !!options.uid)) {
      yield await this.#describe(message, folder, query);
    }
  }

  async fetchOne(range: string, query: FetchQueryObject, options: { uid?: boolean } = {}): Promise<FetchMessageObject | false> {
    this.#step("fetchOne");
    const folder = this.#selected();
    const [message] = parseRange(range, folder.messages, !!options.uid);
    return message ? this.#describe(message, folder, query) : false;
  }

  async #describe(message: StoredMessage, folder: StoredFolder, query: FetchQueryObject): Promise<FetchMessageObject> {
    const result: FetchMessageObject = { seq: folder.messages.indexOf(message) + 1, uid: message.uid };
    if (query.flags) result.flags = new Set(message.flags);
    if (query.source) result.source = message.raw;
    if (query.size) result.size = message.raw.length;
    if (query.envelope || query.bodyStructure) {
      const parsed = await simpleParser(message.raw);
      if (query.envelope) {
        const from = parsed.from?.value[0];
        const to = (Array.isArray(parsed.to) ? parsed.to : parsed.to ? [parsed.to] : []).flatMap((t) => t.value);
        result.envelope = {
          subject: parsed.subject,
          date: parsed.date,
          messageId: parsed.messageId,
          from: from ? [{ name: from.name, address: from.address }] : [],
          to: to.map((t) => ({ name: t.name, address: t.address }))
        };
      }
      if (query.bodyStructure) {
        // Only what the server reads from a structure: a text part, and one node per attachment.
        const text: MessageStructureObject = { type: "text/plain", part: "1" };
        const attachments = parsed.attachments.map((a, i): MessageStructureObject =>
          ({ type: a.contentType, part: String(i + 2), disposition: a.contentDisposition }));
        result.bodyStructure = attachments.length ? { type: "multipart/mixed", childNodes: [text, ...attachments] } : text;
      }
    }
    return result;
  }

  async search(query: SearchObject): Promise<number[]> {
    this.#step("search");
    const matches: number[] = [];
    for (const message of this.#selected().messages) {
      const parsed = await simpleParser(message.raw);
      const has = (text: string | undefined, wanted: string) => (text ?? "").toLowerCase().includes(wanted.toLowerCase());
      const ok =
        (query.uid === undefined || String(query.uid).split(",").map(Number).includes(message.uid)) &&
        (query.from === undefined || has(parsed.from?.text, query.from)) &&
        (query.to === undefined || has(Array.isArray(parsed.to) ? parsed.to.map((t) => t.text).join(",") : parsed.to?.text, query.to)) &&
        (query.subject === undefined || has(parsed.subject, query.subject)) &&
        (query.body === undefined || has(parsed.text, query.body)) &&
        (query.seen === undefined || message.flags.has("\\Seen") === query.seen) &&
        (query.flagged === undefined || message.flags.has("\\Flagged") === query.flagged) &&
        (query.since === undefined || (parsed.date ?? new Date(0)) >= new Date(query.since)) &&
        (query.before === undefined || (parsed.date ?? new Date(0)) < new Date(query.before)) &&
        (query.header === undefined || Object.entries(query.header).every(([key, value]) =>
          has(String(parsed.headers.get(key.toLowerCase()) ?? ""), String(value))));
      if (ok) matches.push(message.uid);
    }
    return matches;
  }

  #transfer(range: string, destination: string, remove: boolean) {
    const source = this.#selected();
    const target = this.#account.folders.get(destination);
    if (!target) return false;
    const picked = parseRange(range, source.messages, true);
    const uidMap = new Map<number, number>();
    for (const message of picked) {
      const uid = target.uidNext++;
      target.messages.push({ uid, raw: message.raw, flags: new Set(message.flags) });
      uidMap.set(message.uid, uid);
    }
    if (remove) source.messages = source.messages.filter((m) => !picked.includes(m));
    return { path: (this.mailbox as { path: string }).path, destination, uidMap };
  }

  async messageMove(range: string, destination: string) {
    this.#step("move");
    return this.#transfer(range, destination, true);
  }

  async messageCopy(range: string, destination: string) {
    this.#step("copy");
    return this.#transfer(range, destination, false);
  }

  async messageDelete(range: string): Promise<boolean> {
    this.#step("delete");
    const folder = this.#selected();
    const picked = parseRange(range, folder.messages, true);
    folder.messages = folder.messages.filter((m) => !picked.includes(m));
    return true;
  }

  async messageFlagsAdd(range: string, flags: string[]): Promise<boolean> {
    this.#step("flagsAdd");
    parseRange(range, this.#selected().messages, true).forEach((m) => flags.forEach((f) => m.flags.add(f)));
    return true;
  }

  async messageFlagsRemove(range: string, flags: string[]): Promise<boolean> {
    this.#step("flagsRemove");
    parseRange(range, this.#selected().messages, true).forEach((m) => flags.forEach((f) => m.flags.delete(f)));
    return true;
  }

  async append(path: string, content: Buffer, flags: string[] = []) {
    this.#step("append");
    const uid = this.#account.add(path, content, flags);
    return { destination: path, uid };
  }
}
