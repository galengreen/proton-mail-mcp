import test from "node:test";
import assert from "node:assert/strict";
import { simpleParser } from "mailparser";
import { attachmentContent, describeAttachments, findAttachment, kindOf, LIMITS } from "../src/attachments/index.ts";
import { makePdf, rawMessage } from "./helpers/messages.ts";

const INVITE = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Standup\r\nDTSTART:20261007T210000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

async function mailWith(attachments: Parameters<typeof rawMessage>[0]["attachments"], extra = {}) {
  return simpleParser(await rawMessage({ from: "a@example.org", text: "See attached", attachments, ...extra }), { keepCidLinks: true });
}

test("kindOf recognises PDFs sent as generic binaries", () => {
  assert.equal(kindOf({ contentType: "application/octet-stream", filename: "Invoice.PDF" }), "pdf");
  assert.equal(kindOf({ contentType: "application/octet-stream", filename: "data.bin" }), "binary");
  assert.equal(kindOf({ contentType: "text/calendar", filename: undefined }), "calendar");
});

test("kindOf returns only images a model can view as images", () => {
  for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp"]) assert.equal(kindOf({ contentType: type, filename: undefined }), "image", type);
  for (const type of ["image/heic", "image/tiff", "image/svg+xml"]) assert.equal(kindOf({ contentType: type, filename: undefined }), "binary", type);
});

test("describeAttachments stops inlining text once the total budget is spent", async () => {
  const mail = await mailWith([
    { filename: "one.txt", content: "a".repeat(80) },
    { filename: "two.txt", content: "b".repeat(80) },
    { filename: "three.txt", content: "c".repeat(80) }
  ]);
  const [one, two, three] = await describeAttachments(mail.attachments, { ...LIMITS, inlineTotal: 120 });
  assert.equal(one?.content, "a".repeat(80));
  assert.equal(two?.content, "b".repeat(40));
  assert.equal(two?.truncated, true);
  assert.equal(three?.content, null);
  assert.match(three?.note ?? "", /read_attachment/);
});

test("describeAttachments includes text, invites and PDF text", async () => {
  const mail = await mailWith([
    { filename: "notes.txt", content: "Gate code 4321" },
    { filename: "invite.ics", content: INVITE, contentType: "text/calendar; method=REQUEST" },
    { filename: "invoice.pdf", content: makePdf([{ text: "Amount NZ$10.00", x: 72, y: 700 }]) },
    { filename: "photo.jpg", content: Buffer.from([0xff, 0xd8, 0xff]) }
  ]);
  const [text, invite, pdf, photo] = await describeAttachments(mail.attachments);
  assert.equal(text?.content, "Gate code 4321");
  assert.equal(invite?.calendar?.method, "REQUEST");
  assert.equal(invite?.calendar?.events[0]?.summary, "Standup");
  assert.equal(pdf?.content, "Amount NZ$10.00");
  assert.equal(pdf?.pages, 1);
  assert.equal(photo?.content, undefined);
  assert.equal(photo?.index, 3);
});

test("text in a legacy charset is decoded", async () => {
  const mail = await mailWith([{ filename: "old.txt", content: Buffer.from([0x63, 0x61, 0x66, 0xe9]), contentType: "text/plain; charset=iso-8859-1" }]);
  const [entry] = await describeAttachments(mail.attachments);
  assert.equal(entry?.content, "café");
});

test("large text is left for read_attachment, and a broken PDF gets a note", async () => {
  const mail = await mailWith([
    { filename: "big.csv", content: "x".repeat(200), contentType: "text/csv" },
    { filename: "broken.pdf", content: Buffer.from("%PDF-1.4 nonsense") }
  ]);
  const [big, broken] = await describeAttachments(mail.attachments, { ...LIMITS, inlineText: 100 });
  assert.equal(big?.content, null);
  assert.match(big?.note ?? "", /read_attachment/);
  assert.equal(broken?.content, null);
  assert.match(broken?.note ?? "", /Text not extracted/);
});

test("findAttachment matches by index or filename and lists the options when it cannot", async () => {
  const mail = await mailWith([{ filename: "A.txt", content: "a" }, { filename: "b.txt", content: "b" }]);
  assert.equal(findAttachment(mail.attachments, { filename: "a.TXT" }).index, 0);
  assert.equal(findAttachment(mail.attachments, { index: 1, filename: "a.txt" }).index, 1);
  assert.throws(() => findAttachment(mail.attachments, { index: 5 }), /No attachment with index 5\. Attachments: 0: A\.txt/);
  assert.throws(() => findAttachment(mail.attachments, {}), /index or the filename/);
});

test("attachmentContent returns images to look at and other files as base64", async () => {
  const mail = await mailWith([
    { filename: "scan.png", content: Buffer.from("png-bytes"), contentType: "image/png" },
    { filename: "data.bin", content: Buffer.from("bytes"), contentType: "application/octet-stream" },
    { filename: "huge.png", content: Buffer.alloc(50), contentType: "image/png" }
  ]);
  const [scan, data, huge] = mail.attachments;
  const image = await attachmentContent(scan!, 0);
  assert.deepEqual(image[1], { type: "image", data: Buffer.from("png-bytes").toString("base64"), mimeType: "image/png" });
  const binary = await attachmentContent(data!, 1);
  assert.match(binary[0]?.type === "text" ? binary[0].text : "", /"contentBase64":"Ynl0ZXM="/);
  const tooBig = await attachmentContent(huge!, 2, { ...LIMITS, image: 10 });
  assert.equal(tooBig.length, 1);
  assert.match(tooBig[0]?.type === "text" ? tooBig[0].text : "", /over the 10 byte limit/);
});
