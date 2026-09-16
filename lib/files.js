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

// No fallback: local PDF/file links must be uploaded as native `pdf` blocks
// (like "Analisando a escrita da Bolha" `{"type":"pdf","attrs":{"filename":"...", "href":"https://.../f/<fileKey>.pdf"}}`),
// not kept as relative `href:"./file.pdf"` links. Substack's file S3 flow is still being reverse-engineered
// (image `POST {pub}/image` rejects `application/pdf` with "URI de dados inválido", audio S3 needs `audio/mpeg`).
// Until the `POST {pub}/api/v1/file` presigned flow is mapped, we fail fast so a broken link is not silently published.

export async function handleLocalFileLinks({ markdown, baseDir }) {
  const links = findLocalFileLinks(markdown);
  if (!links.length) return { fileMap: new Map(), markdown };
  const uniq = new Map();
  for (const l of links) {
    if (!uniq.has(l.href)) uniq.set(l.href, l);
  }
  for (const [href, info] of uniq) {
    const filePath = path.isAbsolute(href) ? href : path.resolve(baseDir || ".", href);
    if (!fs.existsSync(filePath)) {
      throw new Error(`linked file not found: ${href} -> ${filePath} (remove the link or add the file)`);
    }
    // Found a local file that would need upload as `pdf` block — no generic file API yet, so fail fast
    throw new Error(
      `local file link "${href}" (${path.basename(filePath)}) requires native PDF upload as in "Analisando a escrita da Bolha" (pdf node with fileKey/href), not a relative link. ` +
      `The file S3 presigned flow (POST {pub}/api/v1/file) is not yet mapped — image upload rejects PDFs and audio S3 only accepts audio/mpeg. ` +
      `Remove the link fallback as requested; host the PDF externally and use https://.../file.pdf in the markdown, or wait for the native pdf block implementation.`
    );
  }
  return { fileMap: new Map(), markdown };
}
