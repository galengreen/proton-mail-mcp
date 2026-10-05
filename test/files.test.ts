import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAttachmentFile } from "../src/files.ts";

const base = realpathSync(mkdtempSync(join(tmpdir(), "pm-files-")));
const allowed = join(base, "Documents");
const secret = join(base, ".ssh");
mkdirSync(join(allowed, ".hidden"), { recursive: true });
mkdirSync(secret);
writeFileSync(join(allowed, "report.pdf"), "report");
writeFileSync(join(allowed, ".env"), "TOKEN=x");
writeFileSync(join(allowed, ".hidden", "file.txt"), "x");
writeFileSync(join(secret, "id_ed25519"), "key");
symlinkSync(join(secret, "id_ed25519"), join(allowed, "innocent.txt"));
writeFileSync(join(allowed, "big.bin"), Buffer.alloc(100));

test("a file in an allowed folder is read", async () => {
  const file = await readAttachmentFile(join(allowed, "report.pdf"), [allowed]);
  assert.equal(file.filename, "report.pdf");
  assert.equal(file.content.toString(), "report");
});

test("files outside the allowed folders are refused, also through ..", async () => {
  await assert.rejects(readAttachmentFile(join(secret, "id_ed25519"), [allowed]), /outside the folders/);
  await assert.rejects(readAttachmentFile(join(allowed, "..", ".ssh", "id_ed25519"), [allowed]), /outside the folders/);
});

test("a symlink pointing outside is refused", async () => {
  await assert.rejects(readAttachmentFile(join(allowed, "innocent.txt"), [allowed]), /outside the folders/);
});

test("hidden files and hidden folders are refused", async () => {
  await assert.rejects(readAttachmentFile(join(allowed, ".env"), [allowed]), /hidden/);
  await assert.rejects(readAttachmentFile(join(allowed, ".hidden", "file.txt"), [allowed]), /hidden/);
});

test("folders, missing files and oversized files are refused", async () => {
  await assert.rejects(readAttachmentFile(allowed, [allowed]), /outside the folders/);
  await assert.rejects(readAttachmentFile(join(allowed, "nope.txt"), [allowed]), /File not found/);
  await assert.rejects(readAttachmentFile(join(allowed, "big.bin"), [allowed], 10), /over the 10 byte/);
});
