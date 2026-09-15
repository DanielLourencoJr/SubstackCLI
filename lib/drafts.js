import { mdToTiptap } from "./md.js";
import { resolveBylines } from "./auth.js";

export async function createDraft({ sid, publicationUrl, markdown, title, subtitle, audience = "everyone" }) {
  // publicationUrl like danielloureno.substack.com or https://...
  let host = publicationUrl;
  if (!host) throw new Error("publicationUrl required (--pub or --publication-url)");
  if (!host.startsWith("http")) host = `https://${host}`;
  const base = `${host.replace(/\/+$/, "")}/api/v1`;

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
  let host = publicationUrl;
  if (!host.startsWith("http")) host = `https://${host}`;
  const base = `${host.replace(/\/+$/, "")}/api/v1`;
  const r = await fetch(`${base}/drafts/${id}`, {
    headers: { Cookie: `substack.sid=${sid}`, "Content-Type": "application/json" },
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!r.ok) throw new Error(`GET /drafts/${id} HTTP ${r.status}: ${text.slice(0, 500)}`);
  return json;
}

export async function deleteDraft({ sid, publicationUrl, id }) {
  let host = publicationUrl;
  if (!host.startsWith("http")) host = `https://${host}`;
  const base = `${host.replace(/\/+$/, "")}/api/v1`;
  const r = await fetch(`${base}/drafts/${id}`, {
    method: "DELETE",
    headers: { Cookie: `substack.sid=${sid}`, "Content-Type": "application/json" },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`DELETE /drafts/${id} HTTP ${r.status}: ${text.slice(0, 500)}`);
  return true;
}
