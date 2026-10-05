import { readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { expandHome } from "./config.ts";

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export interface LocalFile {
  filename: string;
  content: Buffer;
}

function inside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Read a file the user wants attached to a draft.
 *
 * Email content is untrusted, and a message could try to talk the model into
 * attaching something private such as an SSH key. So only files inside the
 * configured directories are allowed, never hidden files or anything in a
 * hidden directory, and symlinks are resolved before the check so they
 * cannot point elsewhere.
 */
export async function readAttachmentFile(path: string, allowedDirs: string[], maxBytes = MAX_ATTACHMENT_BYTES): Promise<LocalFile> {
  const requested = resolve(expandHome(path));
  let real: string;
  try {
    real = await realpath(requested);
  } catch {
    throw new Error(`File not found: ${path}`);
  }
  const roots = await Promise.all(allowedDirs.map((dir) => realpath(dir).catch(() => null)));
  const root = roots.find((dir): dir is string => dir !== null && inside(dir, real));
  if (!root) {
    throw new Error(
      `${path} is outside the folders attachments may come from (${allowedDirs.join(", ")}). ` +
      "Set PROTON_BRIDGE_ATTACHMENT_DIRS to allow other folders."
    );
  }
  if (relative(root, real).split(sep).some((part) => part.startsWith("."))) {
    throw new Error(`${path} is a hidden file or inside a hidden folder, which cannot be attached.`);
  }
  const info = await stat(real);
  if (!info.isFile()) throw new Error(`${path} is not a file.`);
  if (info.size > maxBytes) throw new Error(`${path} is ${info.size} bytes, over the ${maxBytes} byte attachment limit.`);
  return { filename: basename(requested), content: await readFile(real) };
}
