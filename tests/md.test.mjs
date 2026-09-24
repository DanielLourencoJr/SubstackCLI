import { test } from "node:test";
import assert from "node:assert/strict";
import { mdToTiptap, parseInline } from "../lib/md.js";
import { tiptapToMarkdown } from "../lib/convert.js";

test("parseInline bold", () => {
  const nodes = parseInline("Hello **bold** world");
  assert.equal(nodes.length, 3);
  assert.equal(nodes[1].marks[0].type, "strong");
  assert.equal(nodes[1].text, "bold");
});

test("parseInline em + link", () => {
  const nodes = parseInline("*italic* and [link](https://example.com)");
  assert.equal(nodes[0].marks[0].type, "em");
  assert.equal(nodes[2].marks[0].type, "link");
  assert.equal(nodes[2].marks[0].attrs.href, "https://example.com");
});

test("mdToTiptap heading", () => {
  const doc = mdToTiptap("# Title\n\nParagraph");
  assert.equal(doc.content[0].type, "heading");
  assert.equal(doc.content[0].attrs.level, 1);
  assert.equal(doc.content[1].type, "paragraph");
});

test("mdToTiptap bulletList", () => {
  const doc = mdToTiptap("- a\n- b");
  assert.equal(doc.content[0].type, "bulletList");
  assert.equal(doc.content[0].content.length, 2);
});

test("mdToTiptap orderedList", () => {
  const doc = mdToTiptap("1. first\n2. second");
  assert.equal(doc.content[0].type, "orderedList");
});

test("mdToTiptap codeBlock", () => {
  const doc = mdToTiptap("```js\nconsole.log(1)\n```");
  assert.equal(doc.content[0].type, "codeBlock");
  assert.equal(doc.content[0].attrs.language, "js");
});

test("mdToTiptap blockquote + hr", () => {
  const doc = mdToTiptap("> quote\n\n---\n\nend");
  assert.equal(doc.content[0].type, "blockquote");
  assert.equal(doc.content[1].type, "horizontalRule");
});

test("mdToTiptap link + code inline", () => {
  const doc = mdToTiptap("Paragraph with `code` and [link](https://a.com)");
  const para = doc.content[0];
  const hasCode = para.content.some((n) => n.marks?.some((m) => m.type === "code"));
  const hasLink = para.content.some((n) => n.marks?.some((m) => m.type === "link"));
  assert.ok(hasCode);
  assert.ok(hasLink);
});

test("round-trip preserves subscribe widgets and joins adjacent ordered lists", () => {
  const subscribeWidget = {
    type: "subscribeWidget",
    attrs: { url: "%%checkout_url%%", text: "Inscreva-se", language: "pt-br" },
    content: [{
      type: "ctaCaption",
      content: [{ type: "text", text: "Obrigado por ler! Assine gratuitamente." }],
    }],
  };
  const list = (text) => ({
    type: "orderedList",
    content: [{
      type: "listItem",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    }],
  });
  const original = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Intro" }] },
      list("First"),
      list("Second"),
      subscribeWidget,
      { type: "paragraph", content: [{ type: "text", text: "Outro" }] },
    ],
  };

  const markdown = tiptapToMarkdown(original);
  const restored = mdToTiptap(markdown);
  const lists = restored.content.filter((node) => node.type === "orderedList");

  assert.equal(lists.length, 1);
  assert.equal(lists[0].content.length, 2);
  assert.deepEqual(restored.content.find((node) => node.type === "subscribeWidget"), subscribeWidget);
});
