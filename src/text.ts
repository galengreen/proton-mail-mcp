import { convert } from "html-to-text";

// Format characters, combining marks and fillers render as nothing. Bulk mail
// pads its text/plain part with them so preview panes show a blank line; a
// part made only of these has nothing to read.
const INVISIBLE = /[\p{Cf}\p{Mn}\p{Z}\sᅟᅠㅤﾠ]/gu;

export function isBlank(text: string | null | undefined): boolean {
  return !text || text.replace(INVISIBLE, "") === "";
}

export function htmlToText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: "img", format: "skip" },
      { selector: "a", options: { hideLinkHrefIfSameAsText: true } }
    ]
  }).trim();
}

const DATA_URI = /data:([\w.+-]+\/[\w.+-]+)?(?:;[\w-]+=[^;,"']*)*;base64,([A-Za-z0-9+/=\s]+)/g;

/**
 * Replace base64 data: URIs longer than `minChars` with a short marker. Some
 * senders embed whole images in the HTML, which adds nothing a reader can
 * use. Small ones, usually icons, are left as they are.
 */
export function stripLargeDataUris(html: string, minChars = 1024): string {
  return html.replace(DATA_URI, (match, type: string | undefined, payload: string) => {
    if (payload.length < minChars) return match;
    const bytes = Math.floor((payload.replace(/\s/g, "").length * 3) / 4);
    return `[embedded ${type ?? "data"} removed, ${bytes} bytes]`;
  });
}

export interface Truncated {
  text: string;
  truncated: boolean;
}

/**
 * Shorten `text` to at most `maxBytes` of UTF-8, cutting only between
 * characters so the result never ends in a broken one.
 */
export function truncateUtf8(text: string, maxBytes: number): Truncated {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  // UTF-8 continuation bytes look like 10xxxxxx; back up to a lead byte.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

/** Prefix every line with "> ", as mail clients do for a quoted reply. */
export function quoteLines(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .trimEnd()
    .split("\n")
    .map((line) => (line.startsWith(">") ? `>${line}` : `> ${line}`).trimEnd())
    .join("\n");
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
