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

// For now, Substack has no documented generic file upload for PDFs via API.
// The image endpoint rejects PDFs ("URI de dados inválido"), and file/audio S3 flows
// require postId and are for audio/video only. So we keep links as-is but warn
// and ensure the href is preserved correctly in Tiptap (no upload).
// If a future endpoint is discovered, replace this with actual upload logic.

export async function handleLocalFileLinks({ markdown, baseDir }) {
  const links = findLocalFileLinks(markdown);
  if (!links.length) return { fileMap: new Map(), markdown };
  const uniq = new Map();
  for (const l of links) {
    if (!uniq.has(l.href)) uniq.set(l.href, l);
  }
  const fileMap = new Map();
  for (const [href, info] of uniq) {
    const filePath = path.isAbsolute(href) ? href : path.resolve(baseDir || ".", href);
    if (!fs.existsSync(filePath)) {
      console.error(`  warn: linked file not found: ${href} -> ${filePath} (link will be kept as-is, may be broken in published post)`);
      continue;
    }
    // No upload — keep href as-is, but log for user to host externally
    console.error(`  note: local file link ${href} (${path.basename(filePath)}) found — Substack has no generic file-upload API for PDFs/docs; link will be published as "${href}" (host the PDF externally for a working URL).`);
    // Map href to itself so mdToTiptap can keep it (no transform)
    fileMap.set(href, { url: href, filePath });
  }
  return { fileMap, markdown };
}
