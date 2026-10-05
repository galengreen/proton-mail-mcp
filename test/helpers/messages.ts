import MailComposer from "nodemailer/lib/mail-composer";
import type Mail from "nodemailer/lib/mailer";

/** Build a raw message the way a real mail client would send it. */
export function rawMessage(options: Mail.Options): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    new MailComposer({ date: new Date("2026-10-01T09:00:00Z"), ...options })
      .compile()
      .build((error, message) => (error ? reject(error) : resolve(message)));
  });
}

/**
 * A minimal one-page PDF whose text layer holds the given lines, each drawn
 * with absolute positions so that layout can be tested. Byte offsets in the
 * cross-reference table are computed, so pdf.js reads it without repair.
 */
export function makePdf(lines: { text: string; x: number; y: number }[]): Buffer {
  const escape = (s: string) => s.replace(/([\\()])/g, "\\$1");
  const stream = lines.map((l) => `BT /F1 12 Tf ${l.x} ${l.y} Td (${escape(l.text)}) Tj ET`).join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}
