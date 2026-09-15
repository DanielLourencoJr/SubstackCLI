/**
 * Minimal Markdown -> Tiptap (draft_body) converter.
 * Supports: headings 1-6, paragraphs, bold, italic, inline code, links, strikethrough,
 * bulletList, orderedList, blockquote, codeBlock, horizontalRule, hardBreak
 * Images become image2 nodes wrapped later in captionedImage if needed.
 *
 * Output: doc with schemaVersion v1
 * Per CONTENT_FORMATS.md Tiptap marks: strong, em, code, strike, underline, link
 */

function parseInline(text) {
  // Tokenize inline: code, link, strong, em, strike
  // Returns array of Tiptap text nodes with marks
  const out = [];
  let i = 0;
  const pushText = (t, marks) => {
    if (!t) return;
    const node = { type: "text", text: t };
    if (marks && marks.length) node.marks = marks;
    out.push(node);
  };

  // Use regex scanning - order: code, link, strong, em, strike
  while (i < text.length) {
    const rem = text.slice(i);

    // inline code `code`
    const codeM = rem.match(/^`([^`]+)`/);
    if (codeM) {
      pushText(codeM[1], [{ type: "code" }]);
      i += codeM[0].length;
      continue;
    }
    // image ![alt](src "title") - produce image2 inline
    const imgM = rem.match(/^!\[([^\]]*)\]\((\S+?)(?:\s+"([^"]*)")?\)/);
    if (imgM) {
      out.push({
        type: "image2",
        attrs: {
          src: imgM[2],
          alt: imgM[1] || null,
          caption: null,
          title: imgM[3] || null,
        },
      });
      i += imgM[0].length;
      continue;
    }
    // link [text](href)
    const linkM = rem.match(/^\[([^\]]+)\]\((\S+?)(?:\s+"[^"]*")?\)/);
    if (linkM) {
      // inner text may have bold/italic - recurse simple
      const innerNodes = parseInline(linkM[1]);
      for (const n of innerNodes) {
        const marks = [...(n.marks || []), { type: "link", attrs: { href: linkM[2] } }];
        pushText(n.text, marks);
        // images inside links not supported - ignore
        if (n.type === "image2") out.push(n);
      }
      // if link text had no marks, we already pushed; special case: single node
      if (innerNodes.length === 0) pushText(linkM[1], [{ type: "link", attrs: { href: linkM[2] } }]);
      i += linkM[0].length;
      continue;
    }
    // strong **text** or __text__
    const strongM = rem.match(/^(\*\*|__)(.+?)\1/);
    if (strongM) {
      pushText(strongM[2], [{ type: "strong" }]);
      i += strongM[0].length;
      continue;
    }
    // strike ~~text~~
    const strikeM = rem.match(/^~~(.+?)~~/);
    if (strikeM) {
      pushText(strikeM[1], [{ type: "strike" }]);
      i += strikeM[0].length;
      continue;
    }
    // em *text* or _text_
    const emM = rem.match(/^(\*|_)([^*_]+?)\1/);
    if (emM) {
      pushText(emM[2], [{ type: "em" }]);
      i += emM[0].length;
      continue;
    }
    // plain char
    pushText(rem[0], null);
    i += 1;
  }

  // merge consecutive text nodes with same marks
  const merged = [];
  for (const n of out) {
    const last = merged[merged.length - 1];
    if (
      last &&
      n.type === "text" &&
      last.type === "text" &&
      JSON.stringify(last.marks || []) === JSON.stringify(n.marks || [])
    ) {
      last.text += n.text;
    } else {
      merged.push(n);
    }
  }
  return merged;
}

function mdToTiptap(markdown) {
  const src = markdown.replace(/\r\n/g, "\n");
  const lines = src.split("\n");
  const content = [];
  let i = 0;
  let inCodeBlock = false;
  let codeBuf = [];
  let codeLang = "";

  const flushCode = () => {
    if (codeBuf.length || inCodeBlock) {
      content.push({
        type: "codeBlock",
        attrs: { language: codeLang || null },
        content: [{ type: "text", text: codeBuf.join("\n") }],
      });
      codeBuf = [];
      codeLang = "";
    }
  };

  // list handling - collect consecutive list lines
  const parseList = (start, ordered) => {
    const items = [];
    let j = start;
    const re = ordered ? /^\s*\d+\.\s+(.*)/ : /^\s*[-*]\s+(.*)/;
    while (j < lines.length) {
      const m = lines[j].match(re);
      if (!m) break;
      const inline = parseInline(m[1]);
      items.push({
        type: "listItem",
        content: [{ type: "paragraph", content: inline.length ? inline : [{ type: "text", text: "" }] }],
      });
      j++;
    }
    return { node: { type: ordered ? "orderedList" : "bulletList", content: items }, next: j };
  };

  while (i < lines.length) {
    let line = lines[i];

    // code block fence
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLang = fence[1] || "";
        codeBuf = [];
      } else {
        inCodeBlock = false;
        flushCode();
      }
      i++;
      continue;
    }
    if (inCodeBlock) {
      codeBuf.push(line);
      i++;
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    // horizontal rule
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      content.push({ type: "horizontalRule" });
      i++;
      continue;
    }

    // heading
    const h = line.match(/^(#{1,6})\s+(.*)/);
    if (h) {
      const level = h[1].length;
      const inline = parseInline(h[2].trim());
      content.push({ type: "heading", attrs: { level }, content: inline.length ? inline : [{ type: "text", text: "" }] });
      i++;
      continue;
    }

    // blockquote
    if (/^\s*>\s+/.test(line)) {
      const bqLines = [];
      while (i < lines.length && /^\s*>\s+/.test(lines[i])) {
        bqLines.push(lines[i].replace(/^\s*>\s+/, ""));
        i++;
      }
      const txt = bqLines.join("\n");
      const inline = parseInline(txt);
      content.push({ type: "blockquote", content: [{ type: "paragraph", content: inline.length ? inline : [{ type: "text", text: "" }] }] });
      continue;
    }

    // bullet list
    if (/^\s*[-*]\s+/.test(line)) {
      const { node, next } = parseList(i, false);
      content.push(node);
      i = next;
      continue;
    }
    // ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const { node, next } = parseList(i, true);
      content.push(node);
      i = next;
      continue;
    }

    // paragraph - collect until blank or block
    const paraLines = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^\s*>\s+/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^\s*([-*_])\s*(\1\s*){2,}$/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
      // hard break: two trailing spaces
      if (lines[i - 1].endsWith("  ")) {
        // keep as separate paragraphs with hardBreak? For now join with hardBreak node handled via inline
      }
      // if next line is blank, break
      if (i < lines.length && !lines[i].trim()) break;
    }
    // handle trailing "  " hard breaks inside paragraph
    const rawPara = paraLines.join("\n");
    // split by two-spaces newline marker
    const paraParts = rawPara.split(/ {2}\n/);
    const inlineGroups = paraParts.map((p) => parseInline(p.trim()));
    // build paragraph with hardBreak between parts
    const paraContent = [];
    for (let k = 0; k < inlineGroups.length; k++) {
      if (k > 0) paraContent.push({ type: "hardBreak" });
      for (const n of inlineGroups[k]) paraContent.push(n);
      if (k < inlineGroups.length - 1 && paraLines.length > 1) {
        // placeholder; actual newline already handled
      }
    }
    // if paraParts originally had no 2-space breaks, just one group
    if (paraContent.length === 0) {
      const inline = parseInline(paraLines.join(" ").trim());
      content.push({ type: "paragraph", content: inline.length ? inline : [{ type: "text", text: "" }] });
    } else {
      // If we split, we already have nodes; but if original had simple lines without hardBreak, this will duplicate.
      // Simpler: if there was no hardBreak marker, just use single inline
      if (paraParts.length === 1) {
        const inline = parseInline(paraParts[0]);
        content.push({ type: "paragraph", content: inline.length ? inline : [{ type: "text", text: "" }] });
      } else {
        content.push({ type: "paragraph", content: paraContent });
      }
    }
  }

  // fallback empty doc
  if (content.length === 0) {
    content.push({ type: "paragraph", content: [{ type: "text", text: "" }] });
  }

  return { type: "doc", attrs: { schemaVersion: "v1" }, content };
}

export { mdToTiptap, parseInline };
