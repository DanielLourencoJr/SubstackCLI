import { mdToTiptap } from "./md.js";
import { resolveBylines } from "./auth.js";
import { uploadImage, findLocalImages } from "./images.js";
import { handleLocalFileLinks } from "./files.js";
import fs from "node:fs";
import path from "node:path";

function pubBase(publicationUrl) {
  if (!publicationUrl) throw new Error("publicationUrl required (--pub)");
  let host = publicationUrl;
  if (!host.startsWith("http")) host = `https://${host}`;
  return `${host.replace(/\/+$/, "")}/api/v1`;
}

async function uploadLocalImages({ markdown, sid, publicationUrl, baseDir }) {
  // handle PDFs/file links first (they rewrite markdown to pdf markers)
  const { fileMap: pdfMap, markdown: afterPdfMarkdown } = await handleLocalFileLinks({ markdown, baseDir, publicationUrl, sid });
  const locals = findLocalImages(afterPdfMarkdown);
  const uniq = new Map(); // src -> {alt,caption, filePath}
  for (const img of locals) {
    if (!uniq.has(img.src)) {
      const filePath = path.isAbsolute(img.src) ? img.src : path.resolve(baseDir || ".", img.src);
      uniq.set(img.src, { ...img, filePath });
    }
  }
  const imageMap = new Map();
  // merge pdfMap first (markers -> pdf nodes)
  for (const [k, v] of pdfMap) imageMap.set(k, v);
  if (!locals.length) return { imageMap, markdown: afterPdfMarkdown };
  let idx = 0;
  for (const [src, info] of uniq) {
    idx++;
    if (!fs.existsSync(info.filePath)) {
      console.error(`  warn: local image not found: ${info.src} -> ${info.filePath} (skipping upload, will send raw src)`);
      continue;
    }
    // 200ms gap per LIMITS.md image upload
    if (idx > 1) await new Promise((r) => setTimeout(r, 200));
    console.error(`  uploading image ${idx}/${uniq.size}: ${info.src} -> ${info.filePath}`);
    const res = await uploadImage({ sid, publicationUrl, filePath: info.filePath });
    imageMap.set(src, {
      url: res.url,
      imageWidth: res.imageWidth,
      imageHeight: res.imageHeight,
      bytes: res.bytes,
      alt: info.alt,
      caption: info.title,
    });
    // also map filePath for convenience
    imageMap.set(info.filePath, {
      url: res.url,
      imageWidth: res.imageWidth,
      imageHeight: res.imageHeight,
      bytes: res.bytes,
      alt: info.alt,
      caption: info.title,
    });
  }
  return { imageMap, markdown: afterPdfMarkdown };
}

export async function createDraft({ sid, publicationUrl, markdown, title, subtitle, audience = "everyone", baseDir = "." }) {
  const base = pubBase(publicationUrl);

  const { imageMap, markdown: mdWithPdf } = await uploadLocalImages({ markdown, sid, publicationUrl, baseDir });
  const tiptapDoc = mdToTiptap(mdWithPdf, { imageMap });
  const draftBody = JSON.stringify(tiptapDoc);

  // size check LIMITS.md ~976 KB
  if (Buffer.byteLength(draftBody, "utf8") > 976 * 1024) {
    throw new Error(`draft_body too large (${Buffer.byteLength(draftBody, "utf8")} bytes > 976KB)`);
  }

  const { bylines } = await resolveBylines(sid, publicationUrl);

  const payload = {
    draft_title: title || "Untitled",
    draft_subtitle: subtitle || "",
    draft_body: draftBody,
    type: "newsletter",
    audience,
    draft_bylines: bylines,
    section_chosen: false,
    write_comment_permissions: "everyone",
  };

  const r = await fetch(`${base}/drafts`, {
    method: "POST",
    headers: { Cookie: `substack.sid=${sid}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!r.ok) throw new Error(`POST /drafts HTTP ${r.status}: ${text.slice(0, 800)}`);
  const createdId = json.id;
  // If there were PDFs, they were created with placeholder fileKeys (no S3 upload yet because postId wasn't known).
  // Now that we have the draft id, upload each PDF for real and patch the draft.
  const pdfEntries = [...imageMap.entries()].filter(([k, v]) => v && v.type === "pdf");
  if (pdfEntries.length) {
    // Deduplicate by fileKey
    const seen = new Set();
    for (const [key, pdfNode] of pdfEntries) {
      if (!key.startsWith(":::pdf ")) continue; // only markers, not hrefs
      const origHref = [...imageMap.entries()].find(([hk, hv]) => hv === pdfNode)?.[0];
      // Find the original href for this pdfNode to get filePath
      // For placeholder pdfNodes, the filePath is not stored, but we can re-derive from markdown
      // Instead, re-scan markdown for pdf links and upload with the real postId
      // To avoid double work, we call handleLocalFileLinks again with postId
    }
    // Re-run file handling with postId to get real S3 fileKeys and update the draft
    const { handleLocalFileLinks } = await import("./files.js");
    const { uploadPdfFile } = await import("./files.js");
    // Find all pdf links in original markdown
    const { findLocalFileLinks } = await import("./files.js");
    const pdfLinks = findLocalFileLinks(markdown).filter((l) => l.href.toLowerCase().endsWith(".pdf"));
    if (pdfLinks.length) {
      let needsUpdate = false;
      const newDoc = JSON.parse(JSON.stringify(tiptapDoc));
      for (const link of pdfLinks) {
        const filePath = path.isAbsolute(link.href) ? link.href : path.resolve(baseDir || ".", link.href);
        if (!fs.existsSync(filePath)) continue;
        try {
          const uploaded = await uploadPdfFile({ sid, publicationUrl, postId: createdId, filePath });
          // Find the pdf node in the doc with the placeholder fileKey and replace its attrs
          for (const node of newDoc.content) {
            if (node.type === "pdf" && node.attrs?.fileKey?.includes("-")) {
              // Check if this pdf node's title matches the link text or filename
              // For placeholder nodes, fileKey was random UUID; replace with real one
              // Simple: replace the first pdf node that still has placeholder href (contains /f/<uuid>)
              if (node.attrs.href.includes("/f/") && node.attrs.title === link.text) {
                node.attrs.fileKey = uploaded.fileKey;
                node.attrs.href = uploaded.href;
                node.attrs.raw_href = uploaded.rawHref;
                node.attrs.filesize = fs.statSync(filePath).size;
                needsUpdate = true;
                break;
              }
            }
          }
          // If not found by title, replace any pdf node with placeholder
          if (!needsUpdate) {
            for (const node of newDoc.content) {
              if (node.type === "pdf" && node.attrs.href.includes("/f/") && node.attrs.fileKey.includes("-")) {
                // Check if href is placeholder (not yet uploaded)
                // Replace it
                node.attrs.fileKey = uploaded.fileKey;
                node.attrs.href = uploaded.href;
                node.attrs.raw_href = uploaded.rawHref;
                node.attrs.filesize = fs.statSync(filePath).size;
                needsUpdate = true;
                break;
              }
            }
          }
        } catch (e) {
          console.error(`  warn: pdf S3 upload failed for ${link.href}: ${e.message} (keeping placeholder)`);
        }
      }
      if (needsUpdate) {
        const newBody = JSON.stringify(newDoc);
        const updRes = await fetch(`${base}/drafts/${createdId}`, {
          method: "PUT",
          headers: { Cookie: `substack.sid=${sid}`, "Content-Type": "application/json" },
          body: JSON.stringify({ draft_body: newBody }),
        });
        const updText = await updRes.text();
        if (!updRes.ok) console.error(`  warn: could not patch draft ${createdId} with real pdf fileKeys: ${updText.slice(0, 500)}`);
        else {
          console.error(`  pdf: patched draft ${createdId} with real S3 fileKeys`);
          // Update return values to reflect patched doc
          try { json = JSON.parse(updText); } catch {}
          return { id: createdId, raw: json, payload, tiptapDoc: newDoc };
        }
      }
    }
  }
  return { id: createdId, raw: json, payload, tiptapDoc };
}

export async function getDraft({ sid, publicationUrl, id }) {
  const base = pubBase(publicationUrl);
  const r = await fetch(`${base}/drafts/${id}`, {
    headers: { Cookie: `substack.sid=${sid}`, "Content-Type": "application/json" },
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!r.ok) throw new Error(`GET /drafts/${id} HTTP ${r.status}: ${text.slice(0, 500)}`);
  return json;
}

const POST_TRANSLATION_LANGUAGES = new Set([
  "ar", "ca", "da", "de", "en", "en-gb", "es", "fi", "fr", "is", "it",
  "ja", "nl", "no", "pl", "pt-br", "pt-pt", "sv", "tr",
]);

/** Add or update one custom language edition of an unpublished draft. */
export async function translateDraft({ sid, publicationUrl, id, language, markdown, title, subtitle, baseDir = "." }) {
  const lang = String(language || "").toLowerCase();
  if (!POST_TRANSLATION_LANGUAGES.has(lang)) {
    throw new Error(`Unsupported translation language "${language}". Use a Substack language code such as en or ja.`);
  }
  const base = pubBase(publicationUrl);
  const headers = { Cookie: `substack.sid=${sid}`, "Content-Type": "application/json" };
  const waitForRateLimit = () => new Promise((resolve) => setTimeout(resolve, 1000));
  const settingsRes = await fetch(`${base}/publication_settings`, { headers });
  const settingsText = await settingsRes.text();
  let settings;
  try { settings = JSON.parse(settingsText); } catch {}
  if (!settingsRes.ok) throw new Error(`GET /publication_settings HTTP ${settingsRes.status}: ${settingsText.slice(0, 500)}`);
  if (!settings?.additional_post_languages_enabled) {
    throw new Error("Custom post languages are disabled for this publication. Enable Additional post languages in publication settings first.");
  }

  const draft = await getDraft({ sid, publicationUrl, id });
  if (draft.is_published) throw new Error("Language editions can only be changed on an unpublished draft.");
  let sourceLanguage = draft.language;
  if (!sourceLanguage) {
    await waitForRateLimit();
    const detectRes = await fetch(`${base}/drafts/${id}/detect-language`, { headers });
    const detectText = await detectRes.text();
    let detected;
    try { detected = JSON.parse(detectText); } catch {}
    if (!detectRes.ok) throw new Error(`GET /drafts/${id}/detect-language HTTP ${detectRes.status}: ${detectText.slice(0, 500)}`);
    sourceLanguage = detected?.language;
  }
  if (!sourceLanguage) throw new Error("Could not detect the source language of this draft.");
  if (lang === sourceLanguage) throw new Error(`The draft is already written in ${lang}; choose a different translation language.`);

  let edition = (draft.post_translations || []).find((item) => item.language === lang);
  if (!edition) {
    await waitForRateLimit();
    const addRes = await fetch(`${base}/drafts/${id}/translations/${encodeURIComponent(lang)}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ sourceLanguage }),
    });
    const addText = await addRes.text();
    try { edition = JSON.parse(addText); } catch {}
    if (!addRes.ok) throw new Error(`POST /drafts/${id}/translations/${lang} HTTP ${addRes.status}: ${addText.slice(0, 500)}`);
    if (!edition || typeof edition !== "object") throw new Error("Substack created no readable translation edition.");
  }

  const { imageMap, markdown: mdWithPdf } = await uploadLocalImages({ markdown, sid, publicationUrl, baseDir });
  const tiptapDoc = mdToTiptap(mdWithPdf, { imageMap });
  const draftBody = JSON.stringify(tiptapDoc);
  if (Buffer.byteLength(draftBody, "utf8") > 976 * 1024) {
    throw new Error(`translation body too large (${Buffer.byteLength(draftBody, "utf8")} bytes > 976KB)`);
  }
  const translation = {
    ...edition,
    language: lang,
    draft_title: title || edition.draft_title || draft.draft_title,
    draft_subtitle: subtitle ?? edition.draft_subtitle ?? "",
    draft_body: draftBody,
  };
  await waitForRateLimit();
  const updateRes = await fetch(`${base}/drafts/${id}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      draft_title: draft.draft_title,
      draft_subtitle: draft.draft_subtitle ?? "",
      draft_body: draft.draft_body,
      audience: draft.audience || "everyone",
      translations: [translation],
    }),
  });
  const updateText = await updateRes.text();
  let updated;
  try { updated = JSON.parse(updateText); } catch {}
  if (!updateRes.ok) throw new Error(`PUT /drafts/${id} translation HTTP ${updateRes.status}: ${updateText.slice(0, 800)}`);
  const saved = (updated?.post_translations || []).find((item) => item.language === lang);
  if (!saved || saved.draft_body !== draftBody) {
    throw new Error(`Substack did not confirm that the ${lang} translation was saved.`);
  }
  return { id: Number(id), language: lang, title: saved.draft_title, sourceLanguage, translation: saved, draft: updated };
}

export async function updateDraft({ sid, publicationUrl, id, markdown, title, subtitle, audience, baseDir = "." }) {
  const base = pubBase(publicationUrl);
  const { imageMap, markdown: mdWithPdf } = await uploadLocalImages({ markdown, sid, publicationUrl, baseDir });
  const tiptapDoc = mdToTiptap(mdWithPdf, { imageMap });
  const draftBody = JSON.stringify(tiptapDoc);
  if (Buffer.byteLength(draftBody, "utf8") > 976 * 1024) {
    throw new Error(`draft_body too large (${Buffer.byteLength(draftBody, "utf8")} bytes > 976KB)`);
  }
  const existing = await getDraft({ sid, publicationUrl, id });
  const payload = {
    draft_title: title,
    draft_subtitle: subtitle ?? "",
    draft_body: draftBody,
    audience: audience || "everyone",
  };
  // Keep the section selected on the existing post. Omitting this field from
  // the PUT clears it, which makes Substack reject a later republish.
  if (existing.draft_section_id !== undefined && existing.draft_section_id !== null) {
    payload.draft_section_id = existing.draft_section_id;
  }
  // remove undefined title to keep existing
  if (payload.draft_title == null) delete payload.draft_title;
  const r = await fetch(`${base}/drafts/${id}`, {
    method: "PUT",
    headers: { Cookie: `substack.sid=${sid}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!r.ok) throw new Error(`PUT /drafts/${id} HTTP ${r.status}: ${text.slice(0, 800)}`);
  return json;
}

export async function deleteDraft({ sid, publicationUrl, id }) {
  const base = pubBase(publicationUrl);
  const r = await fetch(`${base}/drafts/${id}`, {
    method: "DELETE",
    headers: { Cookie: `substack.sid=${sid}`, "Content-Type": "application/json" },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`DELETE /drafts/${id} HTTP ${r.status}: ${text.slice(0, 500)}`);
  return true;
}

export async function listDrafts({ sid, publicationUrl, offset = 0, limit = 20, order_by = "draft_updated_at", order_direction = "desc" }) {
  const base = pubBase(publicationUrl);
  // try post_management/drafts first (drafts only)
  const url = `${base}/post_management/drafts?offset=${offset}&limit=${limit}&order_by=${order_by}&order_direction=${order_direction}`;
  const r = await fetch(url, { headers: { Cookie: `substack.sid=${sid}`, "Content-Type": "application/json" } });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!r.ok) throw new Error(`GET /post_management/drafts HTTP ${r.status}: ${text.slice(0, 500)}`);
  // normalize: {posts:[], total, isCapped}
  return json;
}

export async function listPublished({ sid, publicationUrl, offset = 0, limit = 20, order_by = "post_date", order_direction = "desc" }) {
  const base = pubBase(publicationUrl);
  const url = `${base}/post_management/published?offset=${offset}&limit=${limit}&order_by=${order_by}&order_direction=${order_direction}`;
  const r = await fetch(url, { headers: { Cookie: `substack.sid=${sid}`, "Content-Type": "application/json" } });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!r.ok) throw new Error(`GET /post_management/published HTTP ${r.status}: ${text.slice(0, 500)}`);
  return json;
}

export async function listScheduled({ sid, publicationUrl, offset = 0, limit = 20 }) {
  const base = pubBase(publicationUrl);
  const url = `${base}/post_management/scheduled?offset=${offset}&limit=${limit}&order_by=draft_updated_at&order_direction=desc`;
  const r = await fetch(url, { headers: { Cookie: `substack.sid=${sid}`, "Content-Type": "application/json" } });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!r.ok) throw new Error(`GET /post_management/scheduled HTTP ${r.status}: ${text.slice(0, 500)}`);
  return json;
}

export async function prepublishDraft({ sid, publicationUrl, id }) {
  const base = pubBase(publicationUrl);
  const r = await fetch(`${base}/drafts/${id}/prepublish`, {
    headers: { Cookie: `substack.sid=${sid}`, "Content-Type": "application/json" },
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!r.ok) throw new Error(`GET /drafts/${id}/prepublish HTTP ${r.status}: ${text.slice(0, 500)}`);
  return json; // {errors:[], suggestions:[]}
}

export async function publishDraft({ sid, publicationUrl, id, send = false, shareAutomatically = false }) {
  const base = pubBase(publicationUrl);
  // run prepublish first (optional but helps)
  const r = await fetch(`${base}/drafts/${id}/publish`, {
    method: "POST",
    headers: { Cookie: `substack.sid=${sid}`, "Content-Type": "application/json" },
    body: JSON.stringify({ send: !!send, share_automatically: !!shareAutomatically }),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!r.ok) throw new Error(`POST /drafts/${id}/publish HTTP ${r.status}: ${text.slice(0, 800)}`);
  return json;
}

export async function scheduleDraft({ sid, publicationUrl, id, triggerAt, postAudience = "everyone" }) {
  const base = pubBase(publicationUrl);
  const r = await fetch(`${base}/drafts/${id}/scheduled_release`, {
    method: "POST",
    headers: { Cookie: `substack.sid=${sid}`, "Content-Type": "application/json" },
    body: JSON.stringify({ trigger_at: triggerAt, post_audience: postAudience }),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!r.ok) throw new Error(`POST /drafts/${id}/scheduled_release HTTP ${r.status}: ${text.slice(0, 800)}`);
  return json;
}

export async function unscheduleDraft({ sid, publicationUrl, id }) {
  const base = pubBase(publicationUrl);
  const r = await fetch(`${base}/drafts/${id}/scheduled_release`, {
    method: "DELETE",
    headers: { Cookie: `substack.sid=${sid}`, "Content-Type": "application/json" },
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!r.ok) throw new Error(`DELETE /drafts/${id}/scheduled_release HTTP ${r.status}: ${text.slice(0, 800)}`);
  return json;
}

export async function getCounts({ sid, publicationUrl }) {
  const base = pubBase(publicationUrl);
  const r = await fetch(`${base}/post_management/counts`, {
    headers: { Cookie: `substack.sid=${sid}`, "Content-Type": "application/json" },
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!r.ok) throw new Error(`GET /post_management/counts HTTP ${r.status}: ${text.slice(0, 500)}`);
  return json;
}
