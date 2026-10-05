import type { MailClient } from "./client.ts";

/**
 * How an operation may be repeated when the connection fails under it.
 *
 * - "repeatable": safe to run twice (reads, setting a flag). A dropped
 *   connection is replaced and the operation runs once more.
 * - "once": must not run twice (saving a draft, moving, deleting). A timeout
 *   can arrive after Bridge has already done the work, so a retry could
 *   leave a duplicate. Instead the connection is checked before starting.
 */
export type RetryPolicy = "repeatable" | "once";

export interface SessionOptions {
  createClient: () => MailClient;
  /** Log out after this long without use. 0 keeps the connection open. */
  idleTimeoutMs: number;
  log?: (message: string) => void;
}

const CONNECTION_LOST = /not connected|connection (?:was )?(?:closed|reset|lost)|socket (?:closed|hang up|destroyed)|timed? ?out|ECONNRESET|EPIPE|ETIMEDOUT/i;

export function isConnectionLost(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message} ${(error as { code?: string }).code ?? ""}` : String(error);
  return CONNECTION_LOST.test(text);
}

/** One IMAP connection shared by every tool call, opened on demand. */
export class ImapSession {
  readonly #options: SessionOptions;
  #client: MailClient | null = null;
  #connecting: Promise<MailClient> | null = null;
  #idleTimer: NodeJS.Timeout | null = null;

  constructor(options: SessionOptions) {
    this.#options = options;
  }

  async run<T>(operation: (client: MailClient) => Promise<T>, policy: RetryPolicy): Promise<T> {
    let { client, reused } = await this.#acquire();
    if (policy === "once" && reused) {
      try {
        await client.noop();
      } catch {
        this.#discard(client);
        ({ client } = await this.#acquire());
      }
    }
    try {
      return await operation(client);
    } catch (error) {
      const lost = !client.usable || isConnectionLost(error);
      if (lost) this.#discard(client);
      if (!lost || policy === "once") throw error;
    } finally {
      this.#scheduleIdle();
    }
    // The connection dropped under a repeatable operation: one more go.
    ({ client } = await this.#acquire());
    try {
      return await operation(client);
    } catch (error) {
      if (!client.usable || isConnectionLost(error)) this.#discard(client);
      throw error;
    } finally {
      this.#scheduleIdle();
    }
  }

  /** Log out cleanly, for shutdown. */
  async close(): Promise<void> {
    this.#clearIdle();
    const client = this.#client ?? (await this.#connecting?.catch(() => null)) ?? null;
    this.#client = null;
    if (!client) return;
    try {
      if (client.usable) await client.logout();
      else client.close();
    } catch {
      client.close();
    }
  }

  /** Drop the connection without waiting, for process exit. */
  closeNow(): void {
    this.#clearIdle();
    try {
      this.#client?.close();
    } catch {
      // Already closed.
    }
    this.#client = null;
  }

  async #acquire(): Promise<{ client: MailClient; reused: boolean }> {
    this.#clearIdle();
    if (this.#client?.usable) return { client: this.#client, reused: true };
    this.#connecting ??= this.#connect().finally(() => {
      this.#connecting = null;
    });
    return { client: await this.#connecting, reused: false };
  }

  async #connect(): Promise<MailClient> {
    const client = this.#options.createClient();
    // ImapFlow reports a failure of an established connection (Bridge
    // restarting, the machine waking from sleep) as an 'error' event. An
    // 'error' event without a listener is thrown by Node and would take the
    // whole server down, so listen and let the next call reconnect.
    client.on("error", (error) => {
      this.#options.log?.(`IMAP connection error: ${error instanceof Error ? error.message : String(error)}`);
      if (this.#client === client) this.#client = null;
    });
    client.on("close", () => {
      if (this.#client === client) this.#client = null;
    });
    await client.connect();
    this.#client = client;
    return client;
  }

  #discard(client: MailClient): void {
    if (this.#client === client) this.#client = null;
    try {
      client.close();
    } catch {
      // Already closed.
    }
  }

  #clearIdle(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
  }

  #scheduleIdle(): void {
    this.#clearIdle();
    const client = this.#client;
    if (!client || this.#options.idleTimeoutMs <= 0) return;
    this.#idleTimer = setTimeout(() => {
      if (this.#client !== client) return;
      this.#client = null;
      client.logout().catch(() => client.close());
    }, this.#options.idleTimeoutMs);
    this.#idleTimer.unref();
  }
}
