import { mdToTiptap } from "./md.js";
import { resolveBylines } from "./auth.js";

function pubBase(publicationUrl) {
  if (!publicationUrl) throw new Error("publicationUrl required (--pub)");
  let host = publicationUrl;
  if (!host.startsWith("http")) host = `https://${host}`;
  return `${host.replace(/\/+$/, "")}/api/v1`;
}

export async function createDraft({ sid, publicationUrl, markdown, title, subtitle, audience = "everyone" }) {
  const base = pubBase(publicationUrl);

  const tiptapDoc = mdToTiptap(markdown);
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
  return { id: json.id, raw: json, payload, tiptapDoc };
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

export async function updateDraft({ sid, publicationUrl, id, markdown, title, subtitle, audience }) {
  const base = pubBase(publicationUrl);
  const tiptapDoc = mdToTiptap(markdown);
  const draftBody = JSON.stringify(tiptapDoc);
  if (Buffer.byteLength(draftBody, "utf8") > 976 * 1024) {
    throw new Error(`draft_body too large (${Buffer.byteLength(draftBody, "utf8")} bytes > 976KB)`);
  }
  const payload = {
    draft_title: title,
    draft_subtitle: subtitle ?? "",
    draft_body: draftBody,
    audience: audience || "everyone",
  };
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
