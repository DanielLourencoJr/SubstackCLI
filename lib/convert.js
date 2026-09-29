/**
 * Tiptap (draft_body) -> Markdown converter.
 * Keeps common Markdown readable and preserves Substack-specific nodes/marks in opaque comments.
 */

function encodeOpaque(node) {
  const json = JSON.stringify(node);
  const b64 = Buffer.from(json, "utf8").toString("base64url");
  return `<!-- substack-cli-node:v1 ${b64} -->`;
}

function encodeOpaqueInline(node) {
  const json = JSON.stringify(node);
  const b64 = Buffer.from(json, "utf8").toString("base64url");
  return `<!-- substack-cli-inline:v1 ${b64} -->`;
}

function marksToMD(text, marks) {
  if (!marks || !marks.length) return text;
  // Markdown has no faithful syntax for Substack-only marks, and nesting several
  // marks is ambiguous in our lightweight parser. Keep the complete text node.
  const markdownMarks = new Set(["strong", "bold", "em", "italic", "code", "strike", "strikethrough", "link"]);
  if (marks.length > 1 || marks.some((m) => !markdownMarks.has(m.type))) {
    return encodeOpaqueInline({ type: "text", text, marks });
  }
  // order: link innermost? For MD, we wrap text with marks. For link, wrap with [text](href)
  let out = text;
  // Separate link from other marks
  const link = marks.find((m) => m.type === "link");
  const other = marks.filter((m) => m.type !== "link");
  // Apply Markdown-compatible marks.
  for (const m of other) {
    if (m.type === "strong" || m.type === "bold") out = `**${out}**`;
    else if (m.type === "em" || m.type === "italic") out = `*${out}*`;
    else if (m.type === "code") out = `\`${out}\``;
    else if (m.type === "strike" || m.type === "strikethrough") out = `~~${out}~~`;
    // Substack-only marks are emitted above as opaque inline nodes.
  }
  if (link) {
    const href = link.attrs?.href || link.attrs?.url || "";
    out = `[${out}](${href})`;
  }
  return out;
}

function inlineContentToMD(content) {
  if (!content || !content.length) return "";
  let out = "";
  for (const node of content) {
    if (node.type === "text") {
      out += marksToMD(node.text || "", node.marks);
    } else if (node.type === "hardBreak") {
      out += "  \n";
    } else if (node.type === "image2") {
      // inline image fallback (should be captionedImage block, but handle)
      const alt = node.attrs?.alt || "";
      const src = node.attrs?.src || "";
      out += `![${alt}](${src})`;
    } else {
      out += encodeOpaqueInline(node);
    }
  }
  return out;
}

function blockToMD(node, depth = 0) {
  switch (node.type) {
    case "heading": {
      const level = node.attrs?.level || 1;
      const hashes = "#".repeat(Math.min(6, level));
      return `${hashes} ${inlineContentToMD(node.content)}\n\n`;
    }
    case "paragraph": {
      if (!node.content || node.content.length === 0) return "\n\n";
      // check if paragraph is actually just image2 (should be captionedImage, but fallback)
      return `${inlineContentToMD(node.content)}\n\n`;
    }
    case "blockquote": {
      const inner = (node.content || []).map((c) => {
        if (c.type === "paragraph") return inlineContentToMD(c.content);
        return blockToMD(c).trim();
      }).join("\n\n");
      return inner.split("\n").map((l) => `> ${l}`).join("\n") + "\n\n";
    }
    case "bulletList":
    case "bullet_list": {
      let out = "";
      for (const item of node.content || []) {
        // list_item or listItem
        const liContent = item.content || [];
        // each listItem contains a paragraph
        let itemMD = "";
        for (const ch of liContent) {
          if (ch.type === "paragraph") itemMD += inlineContentToMD(ch.content);
          else if (ch.type === "bullet_list" || ch.type === "bulletList" || ch.type === "ordered_list" || ch.type === "orderedList") {
            // nested list inside listItem — handled as separate block indented
            const nested = blockToMD(ch, depth + 1);
            itemMD += "\n" + nested.split("\n").map((l) => `  ${l}`).join("\n");
          } else itemMD += blockToMD(ch, depth + 1);
        }
        out += `${"  ".repeat(depth)}- ${itemMD.trim()}\n`;
        // handle nested lists that are separate siblings inside listItem already handled
        // but also handle if nested list is direct sibling content
      }
      return out + "\n";
    }
    case "orderedList":
    case "ordered_list": {
      let out = "";
      let idx = 1;
      for (const item of node.content || []) {
        const liContent = item.content || [];
        let itemMD = "";
        for (const ch of liContent) {
          if (ch.type === "paragraph") itemMD += inlineContentToMD(ch.content);
          else itemMD += blockToMD(ch, depth + 1);
        }
        out += `${"  ".repeat(depth)}${idx}. ${itemMD.trim()}\n`;
        idx++;
      }
      return out + "\n";
    }
    case "listItem":
    case "list_item": {
      // fallback direct
      return `- ${inlineContentToMD((node.content?.[0]?.content) || [])}\n`;
    }
    case "codeBlock":
    case "code_block":
    case "highlighted_code_block": {
      const lang = node.attrs?.language || node.attrs?.lang || "";
      const text = (node.content || []).map((c) => c.text || "").join("\n");
      return `\`\`\`${lang}\n${text}\n\`\`\`\n\n`;
    }
    case "horizontalRule":
    case "horizontal_rule": {
      return `---\n\n`;
    }
    case "hardBreak": {
      return `  \n`;
    }
    case "captionedImage": {
      const img = (node.content || []).find((c) => c.type === "image2");
      const cap = (node.content || []).find((c) => c.type === "caption");
      if (!img) return encodeOpaque(node) + "\n\n";
      const alt = img.attrs?.alt || "";
      const src = img.attrs?.src || "";
      const captionText = (cap?.content || []).map((c) => c.text || "").join("");
      const titlePart = captionText ? ` "${captionText.replace(/"/g, '\\"')}"` : "";
      return `![${alt}](${src}${titlePart})\n\n`;
    }
    case "image2": {
      const alt = node.attrs?.alt || "";
      const src = node.attrs?.src || "";
      return `![${alt}](${src})\n\n`;
    }
    case "pullquote": {
      return encodeOpaque(node) + "\n\n";
    }
    case "calloutBlock":
    case "callout": {
      return encodeOpaque(node) + "\n\n";
    }
    case "footnote": {
      return encodeOpaque(node) + "\n\n";
    }
    case "latex_block":
    case "latexBlock": {
      return encodeOpaque(node) + "\n\n";
    }
    case "youtube2": {
      return encodeOpaque(node) + "\n\n";
    }
    case "subscribeWidget":
    case "ctaCaption": {
      return `${encodeOpaque(node)}\n\n`;
    }
    default: {
      return encodeOpaque(node) + "\n\n";
    }
  }
}

export function tiptapToMarkdown(doc, opts = {}) {
  if (!doc || doc.type !== "doc") throw new Error("Invalid Tiptap doc: missing type doc");
  const content = doc.content || [];
  const mergeAdjacentOrderedLists = opts.mergeAdjacentOrderedLists !== false;
  let md = "";
  for (let i = 0; i < content.length; i++) {
    const node = content[i];
    if (mergeAdjacentOrderedLists && (node.type === "orderedList" || node.type === "ordered_list")) {
      const items = [...(node.content || [])];
      while (i + 1 < content.length && (content[i + 1].type === "orderedList" || content[i + 1].type === "ordered_list")) {
        items.push(...(content[++i].content || []));
      }
      md += blockToMD({ ...node, content: items });
    } else {
      md += blockToMD(node);
    }
  }
  return md.trimEnd() + "\n";
}

export function draftToMarkdown(draft, opts = {}) {
  const rawBody = draft.draft_body || draft.body || draft.body_json || draft.draftBody;
  let doc = null;
  if (typeof rawBody === "string") {
    try { doc = JSON.parse(rawBody); } catch { throw new Error("draft_body is not valid JSON"); }
  } else if (typeof rawBody === "object" && rawBody !== null) {
    doc = rawBody;
  } else {
    // restack / empty draft: no body_html — keep frontmatter and placeholder
    doc = { type: "doc", attrs: { schemaVersion: "v1" }, content: [{ type: "paragraph", content: [{ type: "text", text: `_No editable body (type: ${draft.type || "unknown"}) — slug: ${draft.slug || ""}_` }] }] };
  }
  const mdBody = tiptapToMarkdown(doc, opts);
  // frontmatter
  const fm = {
    title: draft.draft_title || draft.title || "",
    subtitle: draft.draft_subtitle || draft.subtitle || "",
    slug: draft.slug || "",
    audience: draft.audience || "everyone",
    publication_id: draft.publication_id,
    id: draft.id,
  };
  // clean empty
  for (const k of Object.keys(fm)) if (!fm[k]) delete fm[k];
  let fmStr = "";
  if (opts.frontmatter !== false) {
    fmStr = "---\n";
    for (const [k, v] of Object.entries(fm)) {
      if (typeof v === "string" && (/[:#\[\]{}&*!|>'"%@`,]|\n/.test(v) || /^\s/.test(v))) fmStr += `${k}: ${JSON.stringify(v)}\n`;
      else fmStr += `${k}: ${v}\n`;
    }
    fmStr += "---\n\n";
  }
  return fmStr + mdBody;
}
