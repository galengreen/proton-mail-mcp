#!/usr/bin/env node
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { DEFAULT_CREDENTIALS_FILE, buildConfig, isLoopback, readCredentialsFile } from "./config.ts";
import { readAttachmentFile } from "./files.ts";
import { ImapSession } from "./imap/session.ts";
import { Mailbox } from "./mailbox.ts";
import { createServer } from "./server.ts";
import { SmtpSender } from "./smtp.ts";

// stdout carries the MCP protocol, so every message goes to stderr.
const log = (message: string) => console.error(`[proton-mail] ${message}`);

const credentialsPath = process.env.PROTON_BRIDGE_CREDENTIALS_FILE || DEFAULT_CREDENTIALS_FILE;
const credentials = readCredentialsFile(credentialsPath);
if (credentials.warning) log(`Warning: ${credentials.warning}`);
const config = buildConfig(process.env, credentials.values);

if (!config.username || !config.password) {
  log(
    `No Bridge login found. Set PROTON_BRIDGE_USERNAME and PROTON_BRIDGE_PASSWORD, or put them in ${credentialsPath}:\n\n` +
    "  PROTON_BRIDGE_USERNAME=\"you@proton.me\"\n" +
    "  PROTON_BRIDGE_PASSWORD=\"the password shown in the Bridge app\"\n"
  );
  process.exit(1);
}

// Bridge on this machine uses a self-signed certificate, and the traffic
// never leaves the machine. Anywhere else, certificates are checked and
// encryption is required.
const local = isLoopback(config.host);

const session = new ImapSession({
  idleTimeoutMs: config.imapIdleTimeoutMs,
  log,
  createClient: () => new ImapFlow({
    host: config.host,
    port: config.imapPort,
    secure: false,
    ...(local ? {} : { doSTARTTLS: true }),
    auth: { user: config.username, pass: config.password },
    tls: { rejectUnauthorized: !local },
    logger: false
  })
});

const sender = config.allowSend
  ? new SmtpSender({
    idleTimeoutMs: config.smtpIdleTimeoutMs,
    log,
    createTransport: () => nodemailer.createTransport({
      host: config.host,
      port: config.smtpPort,
      secure: config.smtpSecure,
      requireTLS: !config.smtpSecure,
      pool: true,
      maxConnections: 1,
      auth: { user: config.username, pass: config.password },
      tls: { rejectUnauthorized: !local }
    })
  })
  : null;

const deps = {
  config,
  mailbox: new Mailbox(session),
  sender,
  readFile: (path: string) => readAttachmentFile(path, config.attachmentDirs)
};

// serveStdio speaks both the 2026-07-28 protocol and the 2025 one, picking
// whichever the client opens with. The factory builds the server for the
// connection; the Bridge session behind it is shared.
const handle = serveStdio(() => {
  const server = createServer(deps);
  server.server.onclose = () => void stop(0);
  return server;
});

let stopping = false;
async function stop(code: number): Promise<never> {
  if (!stopping) {
    stopping = true;
    // Do not hang on a dead connection.
    setTimeout(() => process.exit(code), 1500).unref();
    sender?.close();
    await session.close().catch(() => {});
    await handle.close().catch(() => {});
  }
  process.exit(code);
}

process.once("SIGINT", () => void stop(0));
process.once("SIGTERM", () => void stop(0));
process.stdin.once("close", () => void stop(0));
process.once("uncaughtException", (error) => {
  log(`Unexpected error: ${error.stack ?? error.message}`);
  void stop(1);
});
process.once("unhandledRejection", (error) => {
  log(`Unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  void stop(1);
});
process.once("exit", () => {
  session.closeNow();
  sender?.close();
});

log(`Ready (Bridge at ${config.host}, sending ${config.allowSend ? "enabled" : "disabled"}).`);
