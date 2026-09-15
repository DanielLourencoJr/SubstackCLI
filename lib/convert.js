/**
 * Tiptap (draft_body) -> Markdown converter.
 * Reverse of lib/md.js. Handles nodes produced by mdToTiptap and by python-substack (pullquote, calloutBlock, footnote, etc.).
 * Unsupported nodes emit opaque comment: <!-- substack-cli-node:v1 BASE64URL -->
 */

function encodeOpaque(node) {
  const json = JSON.stringify(node);
  const b64 = Buffer.from(json, "utf8").toString("base64url");
  return `<!-- substack-cli-node:v1 ${b64} -->`;
}

function marksToMD(text, marks) {
  if (!marks || !marks.length) return text;
  // order: link innermost? For MD, we wrap text with marks. For link, wrap with [text](href)
  let out = text;
  // Separate link from other marks
  const link = marks.find((m) => m.type === "link");
  const other = marks.filter((m) => m.type !== "link");
  // Apply other marks: strong, em, code, strikethrough/strike, superscript, subscript, underline, textStyle (ignore)
  for (const m of other) {
    if (m.type === "strong" || m.type === "bold") out = `**${out}**`;
    else if (m.type === "em" || m.type === "italic") out = `*${out}*`;
    else if (m.type === "code") out = `\`${out}\``;
    else if (m.type === "strike" || m.type === "strikethrough") out = `~~${out}~~`;
    else if (m.type === "underline") out = `<u>${out}</u>`; // no MD, fallback html
    else if (m.type === "superscript") out = `^${out}^`;
    else if (m.type === "subscript") out = `~${out}~`;
    else if (m.type === "textStyle") {
      // colors ignored for MD, keep plain
    }
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
    } else if (node.type === "footnoteAnchor") {
      out += `[^${node.attrs?.number}]`;
    } else if (node.type === "latex" || node.type === "latexInline") {
      const expr = node.attrs?.expression || node.attrs?.persistentExpression || "";
      out += `$${expr}$`;
    } else if (node.type === "image2") {
      // inline image fallback (should be captionedImage block, but handle)
      const alt = node.attrs?.alt || "";
      const src = node.attrs?.src || "";
      out += `![${alt}](${src})`;
    } else {
      out += encodeOpaque(node);
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
    case "codeBlock": {
      const lang = node.attrs?.language || "";
      const text = (node.content?.[0]?.text) || node.content?.map((c) => c.text || "").join("\n") || "";
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
      const inner = (node.content || []).map((p) => {
        if (p.type === "paragraph") return inlineContentToMD(p.content);
        return blockToMD(p).trim();
      }).join("\n\n");
      return `:::pullquote\n${inner}\n:::\n\n`;
    }
    case "calloutBlock":
    case "callout": {
      const inner = (node.content || []).map((p) => {
        if (p.type === "paragraph") return inlineContentToMD(p.content);
        return blockToMD(p).trim();
      }).join("\n\n");
      return `:::callout\n${inner}\n:::\n\n`;
    }
    case "footnote": {
      const num = node.attrs?.number;
      const inner = (node.content || []).map((p) => {
        if (p.type === "paragraph") return inlineContentToMD(p.content);
        return blockToMD(p).trim();
      }).join("\n\n");
      return `[^${num}]: ${inner}\n\n`;
    }
    case "latex_block":
    case "latexBlock": {
      const expr = node.attrs?.persistentExpression || node.attrs?.expression || "";
      return `$$\n${expr}\n$$\n\n`;
    }
    case "youtube2": {
      const src = node.attrs?.src || "";
      return `[YouTube](${src})\n\n`;
    }
    case "subscribeWidget":
    case "ctaCaption": {
      return `<!-- subscribe widget -->\n\n`;
    }
    default: {
      return encodeOpaque(node) + "\n\n";
    }
  }
}

export function tiptapToMarkdown(doc) {
  if (!doc || doc.type !== "doc") throw new Error("Invalid Tiptap doc: missing type doc");
  const content = doc.content || [];
  let md = "";
  for (const node of content) {
    md += blockToMD(node);
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
  const mdBody = tiptapToMarkdown(doc);
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
