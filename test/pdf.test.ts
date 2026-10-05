import test from "node:test";
import assert from "node:assert/strict";
import { layoutText, readPdfText } from "../src/attachments/pdf.ts";
import { makePdf } from "./helpers/messages.ts";

const item = (str: string, x: number, y: number, width = str.length * 6) => ({ str, transform: [12, 0, 0, 12, x, y], width, height: 12 });

test("layoutText keeps a table row on one line, in reading order", () => {
  const text = layoutText([
    item("Total", 300, 600),
    item("Description", 50, 700),
    item("$120.00", 400, 700),
    item("Amount", 50, 600),
    item("Widgets", 50, 650),
    item("$120.00", 400, 651)
  ]);
  assert.equal(text, "Description $120.00\nWidgets $120.00\nAmount Total");
});

test("layoutText joins fragments of one word without a space", () => {
  assert.equal(layoutText([item("Invo", 50, 700, 24), item("ice", 74, 700)]), "Invoice");
});

test("readPdfText extracts the text layer", async () => {
  const pdf = makePdf([
    { text: "Invoice 1042", x: 72, y: 720 },
    { text: "Amount due", x: 72, y: 680 },
    { text: "NZ$86.25", x: 400, y: 680 }
  ]);
  const result = await readPdfText(pdf);
  assert.equal(result.pages, 1);
  assert.equal(result.text, "Invoice 1042\nAmount due NZ$86.25");
});

test("readPdfText reports a file that is not a PDF", async () => {
  await assert.rejects(readPdfText(Buffer.from("not a pdf")), /not a valid PDF|could not be read/);
});
