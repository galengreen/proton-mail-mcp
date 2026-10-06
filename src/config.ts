import { readFileSync, statSync } from "node:fs";
import { isIPv4 } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface Config {
  username: string;
  password: string;
  /** Every address of the account, the username first. Used for From and to recognise your own mail. */
  addresses: string[];
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
  "PROTON_BRIDGE_ADDRESSES",
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
 * lines are skipped, one pair of surrounding quotes is removed, and a
 * comment after the value (" # ...") is dropped.
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
    const quoted = /^(["'])(.*?)\1\s*(?:#.*)?$/.exec(rawValue);
    result[key] = quoted ? (quoted[2] ?? "") : rawValue.replace(/\s+#.*$/, "");
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
  return /^\d+$/.test(value.trim()) ? Number(value.trim()) : fallback;
}

function toPort(value: string, fallback: number): number {
  const n = toInt(value, fallback);
  return n >= 1 && n <= 65535 ? n : fallback;
}

/** The username, then any other addresses given, each once, ignoring case. */
function accountAddresses(username: string, extra: string): string[] {
  const addresses = new Map<string, string>();
  for (const raw of [username, ...extra.split(",")]) {
    const address = raw.trim();
    if (address !== "" && !addresses.has(address.toLowerCase())) addresses.set(address.toLowerCase(), address);
  }
  return [...addresses.values()];
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
  const username = get("PROTON_BRIDGE_USERNAME");
  return {
    username,
    password: get("PROTON_BRIDGE_PASSWORD"),
    addresses: accountAddresses(username, get("PROTON_BRIDGE_ADDRESSES")),
    host: get("PROTON_BRIDGE_HOST") || "127.0.0.1",
    imapPort: toPort(get("PROTON_BRIDGE_IMAP_PORT"), 1143),
    smtpPort: toPort(get("PROTON_BRIDGE_SMTP_PORT"), 1025),
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
