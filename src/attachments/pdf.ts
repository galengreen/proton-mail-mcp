// Text extraction from PDFs with pdf.js. Only the text layer is read; a
// scanned document is a picture of text and has none. Rendering pages to
// images would need a native canvas package, which this server does not use.

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

let pdfjs: Promise<PdfJs> | null = null;

/** pdf.js is large, so it is loaded the first time a PDF is read. */
function loadPdfJs(): Promise<PdfJs> {
  pdfjs ??= (async () => {
    // On import pdf.js warns through console.warn that it cannot render
    // without the canvas package. Rendering is never used here, and console
    // output must not interfere with the stdio protocol, so mute it.
    const warn = console.warn;
    console.warn = () => {};
    try {
      return await import("pdfjs-dist/legacy/build/pdf.mjs");
    } finally {
      console.warn = warn;
    }
  })();
  return pdfjs;
}

export const MAX_PDF_PAGES = 50;

export interface TextItem {
  str: string;
  /** pdf.js text matrix: [a, b, c, d, x, y]. */
  transform: number[];
  width: number;
  height: number;
}

/**
 * Rebuild lines of text from positioned fragments. Fragments whose
 * baselines are within half a line of each other form one line, ordered
 * left to right, with a space wherever there is a visible gap. That keeps
 * a row of a table, such as an invoice line, together on one line.
 */
export function layoutText(items: TextItem[]): string {
  const fragments = items
    .filter((item) => item.str !== "")
    .map((item) => ({
      text: item.str,
      x: item.transform[4] ?? 0,
      y: item.transform[5] ?? 0,
      width: item.width,
      height: Math.max(item.height, 1)
    }));

  const lines: (typeof fragments)[] = [];
  for (const fragment of fragments) {
    const line = lines.find((l) => {
      const first = l[0];
      return first !== undefined && Math.abs(first.y - fragment.y) <= Math.max(first.height, fragment.height) / 2;
    });
    if (line) line.push(fragment);
    else lines.push([fragment]);
  }

  // PDF y coordinates grow upwards, so the top line has the largest y.
  lines.sort((a, b) => (b[0]?.y ?? 0) - (a[0]?.y ?? 0));
  return lines
    .map((line) => {
      line.sort((a, b) => a.x - b.x);
      let out = "";
      let end: number | null = null;
      for (const fragment of line) {
        const gap = end === null ? 0 : fragment.x - end;
        if (end !== null && gap > fragment.height * 0.15 && !out.endsWith(" ") && !fragment.text.startsWith(" ")) out += " ";
        out += fragment.text;
        end = fragment.x + fragment.width;
      }
      return out.replace(/\s+/g, " ").trim();
    })
    .filter((line) => line !== "")
    .join("\n");
}

export interface PdfText {
  pages: number;
  pagesRead: number;
  /** Page texts joined, with a "--- page N ---" marker on multi-page documents. */
  text: string;
  info: Record<string, string>;
}

const INFO_KEYS = ["Title", "Author", "Subject", "Creator", "Producer", "CreationDate", "ModDate"] as const;

/** Read the text layer of a PDF. Throws a readable error for encrypted or broken files. */
export async function readPdfText(data: Buffer, maxPages = MAX_PDF_PAGES): Promise<PdfText> {
  const { getDocument } = await loadPdfJs();
  const task = getDocument({
    data: new Uint8Array(data),
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0
  });
  try {
    const doc = await task.promise;
    const pagesRead = Math.min(doc.numPages, maxPages);
    const texts: string[] = [];
    for (let n = 1; n <= pagesRead; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const text = layoutText(content.items.filter((item): item is TextItem & typeof item => "str" in item));
      page.cleanup();
      if (text !== "") texts.push(doc.numPages > 1 ? `--- page ${n} ---\n${text}` : text);
    }
    const info: Record<string, string> = {};
    try {
      const raw = (await doc.getMetadata()).info as Record<string, unknown>;
      for (const key of INFO_KEYS) {
        const value = raw[key];
        if (typeof value === "string" && value.trim() !== "") info[key.charAt(0).toLowerCase() + key.slice(1)] = value.trim();
      }
    } catch {
      // Metadata is a nicety; the text is what matters.
    }
    return { pages: doc.numPages, pagesRead, text: texts.join("\n\n"), info };
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    if (name === "PasswordException") throw new Error("the PDF is password protected");
    if (name === "InvalidPDFException") throw new Error("the file is not a valid PDF");
    throw new Error(`the PDF could not be read (${error instanceof Error ? error.message : String(error)})`);
  } finally {
    await task.destroy().catch(() => {});
  }
}
