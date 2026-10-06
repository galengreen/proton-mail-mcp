import type {
  AppendResponseObject,
  CopyResponseObject,
  FetchMessageObject,
  FetchQueryObject,
  ListOptions,
  ListResponse,
  ListTreeResponse,
  SearchObject
} from "imapflow";

/**
 * The part of ImapFlow this server uses. Code depends on this rather than on
 * ImapFlow itself so the tests can supply an in-memory mailbox.
 */
export interface MailClient {
  readonly usable: boolean;
  readonly mailbox: { exists: number } | false;
  connect(): Promise<void>;
  logout(): Promise<void>;
  close(): void;
  noop(): Promise<void>;
  on(event: "error" | "close", listener: (error?: unknown) => void): unknown;
  list(options?: ListOptions): Promise<ListResponse[]>;
  listTree(): Promise<ListTreeResponse>;
  getMailboxLock(path: string): Promise<{ release(): void }>;
  fetch(range: string | number[], query: FetchQueryObject, options?: { uid?: boolean }): AsyncIterable<FetchMessageObject>;
  fetchOne(range: string, query: FetchQueryObject, options?: { uid?: boolean }): Promise<FetchMessageObject | false | undefined>;
  search(query: SearchObject, options?: { uid?: boolean }): Promise<number[] | false | undefined>;
  messageMove(range: string, destination: string, options?: { uid?: boolean }): Promise<CopyResponseObject | false>;
  messageCopy(range: string, destination: string, options?: { uid?: boolean }): Promise<CopyResponseObject | false>;
  messageDelete(range: string, options?: { uid?: boolean }): Promise<boolean>;
  messageFlagsAdd(range: string, flags: string[], options?: { uid?: boolean }): Promise<boolean>;
  messageFlagsRemove(range: string, flags: string[], options?: { uid?: boolean }): Promise<boolean>;
  append(path: string, content: Buffer, flags?: string[]): Promise<AppendResponseObject | false>;
}
