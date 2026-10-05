import type { SendMailOptions, SentMessageInfo } from "nodemailer";

/** The part of a nodemailer transport this server uses. */
export interface MailTransport {
  sendMail(message: SendMailOptions): Promise<SentMessageInfo>;
  close(): void;
  on?(event: "error", listener: (error: unknown) => void): unknown;
}

export interface SenderOptions {
  createTransport: () => MailTransport;
  idleTimeoutMs: number;
  log?: (message: string) => void;
}

const CONNECTION_CODES = new Set(["ECONNECTION", "ETIMEDOUT", "ESOCKET"]);

export function isSmtpConnectionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && CONNECTION_CODES.has(code)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /connection (?:closed|reset|lost)|socket (?:closed|hang up)|timed? ?out|ECONNRESET|EPIPE|greeting never received/i.test(message);
}

export const UNCERTAIN_SEND =
  "The connection to Proton Mail Bridge failed while sending, so the message may or may not have gone out. " +
  "Check the Sent folder before trying again. It was not retried automatically, to avoid sending it twice.";

/**
 * Sends mail over a pooled transport that is closed after a quiet spell.
 * A send is attempted exactly once: a connection can fail after Bridge has
 * accepted the message, and there is no way to tell, so a retry could
 * deliver it twice.
 */
export class SmtpSender {
  readonly #options: SenderOptions;
  #transport: MailTransport | null = null;
  #idleTimer: NodeJS.Timeout | null = null;

  constructor(options: SenderOptions) {
    this.#options = options;
  }

  async send(message: SendMailOptions): Promise<SentMessageInfo> {
    const transport = this.#current();
    try {
      return await transport.sendMail(message);
    } catch (error) {
      if (!isSmtpConnectionError(error)) throw error;
      this.#drop(transport);
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${reason}. ${UNCERTAIN_SEND}`, { cause: error });
    } finally {
      this.#scheduleIdle();
    }
  }

  close(): void {
    if (this.#transport) this.#drop(this.#transport);
  }

  #current(): MailTransport {
    this.#clearIdle();
    if (!this.#transport) {
      const transport = this.#options.createTransport();
      // Unhandled, a transport 'error' event would crash the process.
      transport.on?.("error", (error) => {
        this.#options.log?.(`SMTP transport error: ${error instanceof Error ? error.message : String(error)}`);
        if (this.#transport === transport) this.#transport = null;
      });
      this.#transport = transport;
    }
    return this.#transport;
  }

  #drop(transport: MailTransport): void {
    this.#clearIdle();
    if (this.#transport === transport) this.#transport = null;
    try {
      transport.close();
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
    const transport = this.#transport;
    if (!transport || this.#options.idleTimeoutMs <= 0) return;
    this.#idleTimer = setTimeout(() => this.#drop(transport), this.#options.idleTimeoutMs);
    this.#idleTimer.unref();
  }
}
