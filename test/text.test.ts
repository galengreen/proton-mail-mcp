import test from "node:test";
import assert from "node:assert/strict";
import { escapeHtml, htmlToText, isBlank, quoteLines, stripLargeDataUris, truncateUtf8 } from "../src/text.ts";

test("isBlank sees through invisible padding but not real text", () => {
  assert.equal(isBlank("͏­​﻿ \n⁠᠎ㅤ"), true);
  assert.equal(isBlank(""), true);
  assert.equal(isBlank(undefined), true);
  assert.equal(isBlank("​ Kia ora ​"), false);
  assert.equal(isBlank("é"), false);
});

test("htmlToText keeps words and link targets, drops images", () => {
  const text = htmlToText('<p>Hello <b>there</b></p><img src="x.png" alt="logo"><a href="https://example.org/a">details</a>');
  assert.match(text, /Hello there/);
  assert.match(text, /example\.org\/a/);
  assert.doesNotMatch(text, /logo/);
});

test("stripLargeDataUris replaces big payloads and keeps small ones", () => {
  const big = "A".repeat(4000);
  const html = `<img src="data:image/png;base64,${big}"><img src="data:image/gif;base64,R0lGOD">`;
  const out = stripLargeDataUris(html);
  assert.match(out, /\[embedded image\/png removed, 3000 bytes\]/);
  assert.match(out, /R0lGOD/);
});

test("truncateUtf8 never splits a character", () => {
  assert.deepEqual(truncateUtf8("kia ora", 50), { text: "kia ora", truncated: false });
  assert.deepEqual(truncateUtf8("aéé", 4), { text: "aé", truncated: true });
  assert.equal(truncateUtf8("ok🙂", 5).text, "ok");
});

test("quoteLines quotes each line, nesting existing quotes", () => {
  assert.equal(quoteLines("Hi\r\n\n> earlier\n"), "> Hi\n>\n>> earlier");
});

test("escapeHtml escapes markup characters", () => {
  assert.equal(escapeHtml(`<a href="x">&</a>`), "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
});
