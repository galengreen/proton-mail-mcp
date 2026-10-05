import { readFileSync, statSync } from "node:fs";
import { isIPv4 } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface Config {
  username: string;
  password: string;
  host: string;
  imapPort: number;
  smtpPort: number;
  /** Implicit TLS for SMTP. Off means STARTTLS, which Bridge uses by default. */
  smtpSecure: boolean;
  /** Register the send_email and reply_to_email tools. */
  allowSend: boolean;
  imapIdleTimeoutMs: number;
  smtpIdleTimeoutMs: number;
  /** Directories that draft attachments may be read from. */
  attachmentDirs: string[];
}

export const DEFAULT_CREDENTIALS_FILE = join(homedir(), ".proton-bridge-credentials");

const KNOWN_KEYS = new Set([
  "PROTON_BRIDGE_USERNAME",
  "PROTON_BRIDGE_PASSWORD",
  "PROTON_BRIDGE_HOST",
  "PROTON_BRIDGE_IMAP_PORT",
  "PROTON_BRIDGE_SMTP_PORT",
  "PROTON_BRIDGE_SMTP_SECURE",
  "PROTON_BRIDGE_ALLOW_SEND",
  "PROTON_BRIDGE_IDLE_TIMEOUT_MS",
  "PROTON_BRIDGE_SMTP_IDLE_TIMEOUT_MS",
  "PROTON_BRIDGE_ATTACHMENT_DIRS"
]);

/**
 * Read KEY=value lines in the style of a shell env file. Comments and blank
 * lines are skipped, and one pair of surrounding quotes is removed.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key = "", rawValue = ""] = match;
    if (!KNOWN_KEYS.has(key)) continue;
    const quoted = /^(["'])(.*)\1$/.exec(rawValue);
    result[key] = quoted ? (quoted[2] ?? "") : rawValue;
  }
  return result;
}

export interface CredentialsFile {
  values: Record<string, string>;
  /** Set when other users on the machine can read the file. */
  warning?: string;
}

export function readCredentialsFile(path: string): CredentialsFile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { values: {} };
  }
  const file: CredentialsFile = { values: parseEnvFile(text) };
  try {
    if ((statSync(path).mode & 0o077) !== 0) {
      file.warning = `${path} can be read by other users on this machine; run: chmod 600 ${path}`;
    }
  } catch {
    // The file was readable a moment ago; a failed stat is not worth failing over.
  }
  return file;
}

const TRUE = /^(1|true|yes|on)$/i;

function toInt(value: string, fallback: number): number {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function expandHome(path: string, home = homedir()): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

/**
 * Combine the environment with the credentials file. A setting in the
 * environment always wins over the same setting in the file.
 */
export function buildConfig(env: Record<string, string | undefined>, file: Record<string, string>, home = homedir()): Config {
  const get = (key: string): string => env[key] || file[key] || "";
  const dirs = get("PROTON_BRIDGE_ATTACHMENT_DIRS") || "~/Documents:~/Downloads:~/Desktop";
  return {
    username: get("PROTON_BRIDGE_USERNAME"),
    password: get("PROTON_BRIDGE_PASSWORD"),
    host: get("PROTON_BRIDGE_HOST") || "127.0.0.1",
    imapPort: toInt(get("PROTON_BRIDGE_IMAP_PORT"), 1143),
    smtpPort: toInt(get("PROTON_BRIDGE_SMTP_PORT"), 1025),
    smtpSecure: TRUE.test(get("PROTON_BRIDGE_SMTP_SECURE")),
    allowSend: TRUE.test(get("PROTON_BRIDGE_ALLOW_SEND")),
    imapIdleTimeoutMs: toInt(get("PROTON_BRIDGE_IDLE_TIMEOUT_MS"), 5 * 60_000),
    smtpIdleTimeoutMs: toInt(get("PROTON_BRIDGE_SMTP_IDLE_TIMEOUT_MS"), 2 * 60_000),
    attachmentDirs: dirs.split(":").filter(Boolean).map((dir) => resolve(expandHome(dir.trim(), home)))
  };
}

/**
 * Whether `host` is this machine. Only literal loopback addresses and
 * "localhost" count; a name like "127.example.com" is a remote host.
 */
export function isLoopback(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (h === "localhost" || h === "::1") return true;
  return isIPv4(h) && h.startsWith("127.");
}
