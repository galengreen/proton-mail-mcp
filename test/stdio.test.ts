import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

// Starts the real entry point as a child process. Listing tools and refusing
// bad input need no Bridge; the host points at a closed port regardless.
const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const env = {
  PATH: process.env.PATH ?? "",
  PROTON_BRIDGE_CREDENTIALS_FILE: "/nonexistent",
  PROTON_BRIDGE_USERNAME: "me@proton.me",
  PROTON_BRIDGE_PASSWORD: "test",
  PROTON_BRIDGE_IMAP_PORT: "9"
};

async function connect(versionNegotiation?: { mode: "auto" } | { mode: { pin: "2026-07-28" } }) {
  const client = new Client({ name: "test", version: "1" }, versionNegotiation ? { versionNegotiation } : {});
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env, stderr: "ignore" }));
  return client;
}

test("a 2025-era client can connect and list tools", async (t) => {
  const client = await connect();
  t.after(() => client.close());
  const { tools } = await client.listTools();
  assert.equal(tools.length, 12);
  assert.match(client.getInstructions() ?? "", /untrusted/);
});

test("a 2026-07-28 client can connect and list tools", async (t) => {
  const client = await connect({ mode: { pin: "2026-07-28" } });
  t.after(() => client.close());
  assert.equal(client.getProtocolEra(), "modern");
  const { tools } = await client.listTools();
  assert.equal(tools.length, 12);
  assert.ok(tools.find((tool) => tool.name === "read_email")?.annotations?.readOnlyHint);
});

test("invalid input is refused over stdio", async (t) => {
  const client = await connect({ mode: "auto" });
  t.after(() => client.close());
  const result = await client.callTool({ name: "read_email", arguments: { uid: -1 } });
  assert.equal(result.isError, true);
});

test("the server exits with a clear message when there is no login", async () => {
  const { spawnSync } = await import("node:child_process");
  const run = spawnSync(process.execPath, [entry], {
    env: { PATH: env.PATH, PROTON_BRIDGE_CREDENTIALS_FILE: "/nonexistent" },
    input: "",
    encoding: "utf8"
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /No Bridge login found/);
});
