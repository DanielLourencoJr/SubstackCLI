import { test } from "node:test";
import assert from "node:assert/strict";
import { mdToTiptap, parseInline } from "../lib/md.js";
import { tiptapToMarkdown } from "../lib/convert.js";

const roundTripBlock = (node) => {
  const doc = { type: "doc", content: [node] };
  return mdToTiptap(tiptapToMarkdown(doc)).content[0];
};

const roundTripInline = (node) => {
  const doc = { type: "doc", content: [{ type: "paragraph", content: [node] }] };
  return mdToTiptap(tiptapToMarkdown(doc)).content[0].content[0];
};

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

test("round-trip preserves subscribe widgets", () => {
  const widget = {
    type: "subscribeWidget",
    attrs: { url: "%%checkout_url%%", text: "Inscreva-se", language: "pt-br" },
    content: [{ type: "ctaCaption", content: [{ type: "text", text: "Obrigado por ler! Assine gratuitamente." }] }],
  };
  assert.deepEqual(roundTripBlock(widget), widget);
});

test("round-trip preserves actual Substack subscribe buttons", () => {
  const button = { type: "button", attrs: { url: "%%checkout_url%%", text: "Subscreva agora", class: null } };
  assert.deepEqual(roundTripBlock(button), button);
});

test("round-trip preserves ctaCaption blocks", () => {
  const caption = { type: "ctaCaption", content: [{ type: "text", text: "Thanks for reading." }] };
  assert.deepEqual(roundTripBlock(caption), caption);
});

test("round-trip joins adjacent ordered lists", () => {
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
      list("First"),
      list("Second"),
    ],
  };

  const markdown = tiptapToMarkdown(original);
  const restored = mdToTiptap(markdown);
  const lists = restored.content.filter((node) => node.type === "orderedList");

  assert.equal(lists.length, 1);
  assert.equal(lists[0].content.length, 2);
});

const blockCases = [
  ["pullquote blocks", { type: "pullquote", attrs: { color: "#FF5733" }, content: [{ type: "paragraph", content: [{ type: "text", text: "Pull quote" }] }] }],
  ["calloutBlock blocks", { type: "calloutBlock", attrs: { kind: "note" }, content: [{ type: "paragraph", content: [{ type: "text", text: "Callout" }] }] }],
  ["callout alias blocks", { type: "callout", attrs: { kind: "warning" }, content: [{ type: "paragraph", content: [{ type: "text", text: "Callout alias" }] }] }],
  ["footnote blocks", { type: "footnote", attrs: { number: 1 }, content: [{ type: "paragraph", content: [{ type: "text", text: "Footnote body" }] }] }],
  ["latexBlock blocks", { type: "latexBlock", attrs: { expression: "x^2 + y^2 = z^2" } }],
  ["latex_block blocks", { type: "latex_block", attrs: { persistentExpression: "x^2" } }],
  ["YouTube embeds", { type: "youtube2", attrs: { src: "https://www.youtube.com/watch?v=example" } }],
  ["table blocks", { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "Cell" }] }] }] }] }],
  ["PDF blocks", { type: "pdf", attrs: { fileKey: "test.pdf", filename: "test.pdf", href: "https://example.com/test.pdf" } }],
];

for (const [name, node] of blockCases) {
  test(`round-trip preserves ${name}`, () => {
    assert.deepEqual(roundTripBlock(node), node);
  });
}

const markCases = [
  ["underline", { type: "underline" }],
  ["superscript", { type: "superscript" }],
  ["subscript", { type: "subscript" }],
  ["textStyle color", { type: "textStyle", attrs: { color: "#ff0000" } }],
  ["highlight color", { type: "highlight", attrs: { color: "#ffff00" } }],
  ["combined strong and emphasis", [{ type: "strong" }, { type: "em" }]],
];

for (const [name, marks] of markCases) {
  test(`round-trip preserves ${name} text marks`, () => {
    const text = { type: "text", text: "styled text", marks: Array.isArray(marks) ? marks : [marks] };
    assert.deepEqual(roundTripInline(text), text);
  });
}

const inlineNodeCases = [
  ["footnote anchors", { type: "footnoteAnchor", attrs: { number: 1 } }],
  ["inline LaTeX", { type: "latexInline", attrs: { expression: "x^2" } }],
  ["inline latex nodes", { type: "latex", attrs: { persistentExpression: "x^2" } }],
];

for (const [name, node] of inlineNodeCases) {
  test(`round-trip preserves ${name}`, () => {
    assert.deepEqual(roundTripInline(node), node);
  });
}
