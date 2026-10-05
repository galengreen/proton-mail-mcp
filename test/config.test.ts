import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig, isLoopback, parseEnvFile, readCredentialsFile } from "../src/config.ts";

test("parseEnvFile reads quoted, unquoted and exported values", () => {
  const values = parseEnvFile([
    "# Bridge",
    'PROTON_BRIDGE_USERNAME="me@proton.me"',
    "export PROTON_BRIDGE_PASSWORD='p#ss=\"word\"'",
    "PROTON_BRIDGE_IMAP_PORT = 1144",
    "SOMETHING_ELSE=ignored",
    "not a setting"
  ].join("\r\n"));
  assert.deepEqual(values, {
    PROTON_BRIDGE_USERNAME: "me@proton.me",
    PROTON_BRIDGE_PASSWORD: 'p#ss="word"',
    PROTON_BRIDGE_IMAP_PORT: "1144"
  });
});

test("buildConfig uses defaults, and the environment wins over the file", () => {
  const config = buildConfig(
    { PROTON_BRIDGE_PASSWORD: "from-env", PROTON_BRIDGE_ATTACHMENT_DIRS: "~/Mail:/srv/files" },
    { PROTON_BRIDGE_USERNAME: "me@proton.me", PROTON_BRIDGE_PASSWORD: "from-file", PROTON_BRIDGE_ALLOW_SEND: "yes" },
    "/home/me"
  );
  assert.equal(config.username, "me@proton.me");
  assert.equal(config.password, "from-env");
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.imapPort, 1143);
  assert.equal(config.smtpPort, 1025);
  assert.equal(config.smtpSecure, false);
  assert.equal(config.allowSend, true);
  assert.deepEqual(config.attachmentDirs, ["/home/me/Mail", "/srv/files"]);
});

test("buildConfig defaults attachment folders to Documents, Downloads and Desktop", () => {
  assert.deepEqual(buildConfig({}, {}, "/home/me").attachmentDirs, ["/home/me/Documents", "/home/me/Downloads", "/home/me/Desktop"]);
});

test("buildConfig ignores numbers it cannot read", () => {
  assert.equal(buildConfig({ PROTON_BRIDGE_IMAP_PORT: "abc" }, {}).imapPort, 1143);
});

test("readCredentialsFile warns when others can read the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-"));
  const path = join(dir, "creds");
  writeFileSync(path, "PROTON_BRIDGE_USERNAME=me@proton.me\n");
  chmodSync(path, 0o644);
  assert.match(readCredentialsFile(path).warning ?? "", /chmod 600/);
  chmodSync(path, 0o600);
  assert.equal(readCredentialsFile(path).warning, undefined);
  assert.deepEqual(readCredentialsFile(join(dir, "missing")).values, {});
});

test("isLoopback trusts only addresses on this machine", () => {
  for (const host of ["127.0.0.1", "127.8.9.10", "localhost", "LOCALHOST", "::1", "[::1]"]) assert.equal(isLoopback(host), true, host);
  for (const host of ["127.example.com", "10.0.0.1", "bridge.local", "", "::2"]) assert.equal(isLoopback(host), false, host);
});
