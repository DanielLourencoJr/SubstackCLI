import fs from "node:fs";
import path from "node:path";

import crypto from "node:crypto";

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
// File S3: POST {pub}/api/v1/file/{postId} {filename,filetype,filesize} → {fileKey,fileUrl,fields} + POST to S3

export async function handleLocalFileLinks({ markdown, baseDir, publicationUrl, sid, postId }) {
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
    if (ext === ".pdf") {
      const filename = path.basename(filePath);
      let host = "substack.com";
      try {
        if (publicationUrl) {
          const u = publicationUrl.startsWith("http") ? new URL(publicationUrl) : new URL(`https://${publicationUrl}`);
          host = u.hostname;
        }
      } catch {}
      let fileKey, hrefOut, rawHref, pdfNode;
      // If we have postId + sid, do real S3 upload (like Bolha)
      if (sid && publicationUrl && postId) {
        try {
          const uploaded = await uploadPdfFile({ sid, publicationUrl, postId, filePath });
          fileKey = uploaded.fileKey;
          hrefOut = uploaded.href;
          rawHref = uploaded.rawHref;
          console.error(`  pdf: ${href} -> ${filename} (${stat.size}B) uploaded as ${fileKey}`);
        } catch (e) {
          console.error(`  warn: pdf S3 upload failed for ${href}: ${e.message} — using placeholder`);
          fileKey = `${crypto.randomUUID()}.pdf`;
          hrefOut = `https://${host}/f/${fileKey}`;
          rawHref = `https://${host}/api/v1/file/${fileKey}`;
        }
      } else {
        fileKey = `${crypto.randomUUID()}.pdf`;
        hrefOut = `https://${host}/f/${fileKey}`;
        rawHref = `https://${host}/api/v1/file/${fileKey}`;
        if (!postId) console.error(`  pdf: ${href} -> ${filename} (${stat.size}B) as pdf block ${fileKey} (no postId yet, placeholder href — will be replaced on publish)`);
      }
      pdfNode = {
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
      const isStandalone = new RegExp(`^\\s*\\[([^\\]]+)\\]\\(${href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s+"[^"]*")?\\)\\s*$`, "m").test(markdown);
      if (isStandalone) {
        const marker = `:::pdf ${fileKey}:::`;
        newMarkdown = newMarkdown.replace(info.fullMatch, marker);
        fileMap.set(marker, pdfNode);
      } else {
        console.error(`  note: inline PDF link "${href}" will stay as link (use a standalone line "[Download PDF](./file.pdf)" for a file card)`);
      }
      if (!postId) console.error(`  pdf: ${href} -> ${filename} (${stat.size}B) as pdf block ${fileKey}`);
    } else {
      console.error(`  warn: local file link "${href}" (${path.basename(filePath)}) has no Substack file API — keeping href as-is (host externally for working URL)`);
      fileMap.set(href, { url: href });
    }
  }
  return { fileMap, markdown: newMarkdown };
}

export async function uploadPdfFile({ sid, publicationUrl, postId, filePath }) {
  const stat = fs.statSync(filePath);
  const filename = path.basename(filePath);
  let host = publicationUrl;
  if (!host.startsWith("http")) host = `https://${host}`;
  const base = `${host.replace(/\/+$/, "")}/api/v1`;
  // Step 1: get presigned S3 POST fields
  const r = await fetch(`${base}/file/${postId}`, {
    method: "POST",
    headers: { Cookie: `substack.sid=${sid}`, "Content-Type": "application/json" },
    body: JSON.stringify({ filename, filetype: "application/pdf", filesize: stat.size }),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!r.ok) throw new Error(`POST /file/${postId} HTTP ${r.status}: ${text.slice(0, 600)}`);
  const fileKey = json.fileKey || json.file_key || json.key?.split("/").pop();
  const fileUrl = json.fileUrl || `https://${new URL(base).hostname}/f/${fileKey}`;
  const rawHref = `https://${new URL(base).hostname}/api/v1/file/${fileKey}`;
  const href = fileUrl;
  const fields = json.fields || {};
  const s3Url = json.url || "https://substack-post-media.s3.us-east-1.amazonaws.com/";
  // Step 2: POST file binary to S3 with fields
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  form.append("file", new Blob([fs.readFileSync(filePath)], { type: "application/pdf" }), filename);
  const r2 = await fetch(s3Url, { method: "POST", body: form });
  if (!r2.ok) {
    const t2 = await r2.text().catch(() => "");
    throw new Error(`S3 POST HTTP ${r2.status}: ${t2.slice(0, 600)}`);
  }
  return { fileKey, href, rawHref, fileUrl, fields, s3Url };
}
