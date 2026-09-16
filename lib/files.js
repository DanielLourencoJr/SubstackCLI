import fs from "node:fs";
import path from "node:path";

/**
 * Find local file links in markdown: [text](path.pdf) where path is local file.
 * Returns array of {text, href, fullMatch}
 * Ignores http(s), mailto, #anchor, data:
 */
export function findLocalFileLinks(markdown) {
  const re = /\[([^\]]+)\]\((\S+?)(?:\s+"[^"]*")?\)/g;
  const out = [];
  let m;
  while ((m = re.exec(markdown))) {
    const href = m[2];
    // skip images: they are handled separately (preceded by !)
    const before = markdown[m.index - 1];
    if (before === "!") continue;
    // skip external, absolute, data, anchor
    if (/^(https?:|mailto:|tel:|data:|#)/i.test(href)) continue;
    // only handle file-like paths with extension
    if (!/\.[a-z0-9]{2,5}$/i.test(href)) continue;
    // check if looks like local path
    out.push({ text: m[1], href, fullMatch: m[0] });
  }
  return out;
}

// Local PDFs -> native `pdf` blocks like "Analisando a escrita da Bolha"
// `{"type":"pdf","attrs":{"filename":"...", "href":"https://.../f/<fileKey>.pdf", "fileKey":"...pdf"}}`
// File S3 presigned flow (POST {pub}/api/v1/file) is still being mapped, so we create the pdf card
// with a placeholder fileKey/href that renders as a file card (like the live test 216040908 with
// test-123.pdf → <div class="file-embed-wrapper">). Once the S3 PUT is mapped, the binary will be uploaded
// and the href will point to the real S3 file.
import crypto from "node:crypto";

export async function handleLocalFileLinks({ markdown, baseDir, publicationUrl, sid }) {
  const links = findLocalFileLinks(markdown);
  if (!links.length) return { fileMap: new Map(), markdown };
  const uniq = new Map();
  for (const l of links) {
    if (!uniq.has(l.href)) uniq.set(l.href, l);
  }
  const fileMap = new Map();
  let newMarkdown = markdown;
  for (const [href, info] of uniq) {
    const filePath = path.isAbsolute(href) ? href : path.resolve(baseDir || ".", href);
    if (!fs.existsSync(filePath)) {
      throw new Error(`linked file not found: ${href} -> ${filePath} (remove the link or add the file)`);
    }
    const stat = fs.statSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    // Only PDFs become native pdf blocks; other files stay as links (but we have no generic file upload, so keep href)
    if (ext === ".pdf") {
      const fileKey = `${crypto.randomUUID()}.pdf`;
      const filename = path.basename(filePath);
      // Use publication host for href if available, else keep placeholder
      let host = "substack.com";
      try {
        if (publicationUrl) {
          const u = publicationUrl.startsWith("http") ? new URL(publicationUrl) : new URL(`https://${publicationUrl}`);
          host = u.hostname;
        }
      } catch {}
      const hrefOut = `https://${host}/f/${fileKey}`;
      const rawHref = `https://${host}/api/v1/file/${fileKey}`;
      const pdfNode = {
        type: "pdf",
        attrs: {
          filename,
          filetype: "application/pdf",
          filesize: stat.size,
          href: hrefOut,
          raw_href: rawHref,
          fileKey,
          title: info.text || filename.replace(/\.pdf$/i, ""),
          description: null,
          thumbnail: null,
          dirty: true,
          error: null,
          empty: false,
        },
      };
      fileMap.set(href, pdfNode);
      // Replace the markdown link line with a placeholder that mdToTiptap will turn into a pdf block
      // Standalone line: [text](href) -> :::pdf href:::
      // For inline PDFs inside a paragraph, keep as link for now
      const isStandalone = new RegExp(`^\\s*\\[([^\\]]+)\\]\\(${href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s+"[^"]*")?\\)\\s*$`, "m").test(markdown);
      if (isStandalone) {
        // Replace the whole line with a marker that mdToTiptap will detect
        const marker = `:::pdf ${fileKey}:::`; // will be expanded to pdf node via imageMap
        newMarkdown = newMarkdown.replace(info.fullMatch, marker);
        // store marker -> pdfNode mapping
        fileMap.set(marker, pdfNode);
      } else {
        // Inline PDF link: keep as link for now (no pdf block), but href will be replaced with external placeholder if needed
        // For now, keep original href; the pdf block will only be used for standalone lines
        console.error(`  note: inline PDF link "${href}" will stay as link (use a standalone line "[Download PDF](./file.pdf)" for a file card)`);
      }
      console.error(`  pdf: ${href} -> ${filename} (${stat.size}B) as pdf block ${fileKey} (S3 upload not yet wired, card will render with placeholder href)`);
    } else {
      // Non-PDF local file: no Substack file API, keep href as-is with warning
      console.error(`  warn: local file link "${href}" (${path.basename(filePath)}) has no Substack file API — keeping href as-is (host externally for working URL)`);
      fileMap.set(href, { url: href });
    }
  }
  return { fileMap, markdown: newMarkdown };
}
