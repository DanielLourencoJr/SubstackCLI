import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter.js";
import { draftToMarkdown } from "./convert.js";
import { mdToTiptap } from "./md.js";
import {
  createDraft,
  getDraft,
  updateDraft,
  publishDraft,
  listDrafts,
  listPublished,
} from "./drafts.js";

function hashStr(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
}

function normalizeBody(mdBody) {
  // trim and normalize newlines for hashing
  return mdBody.replace(/\r\n/g, "\n").trim();
}

function scanLocal(dir) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true, recursive: true });
  const files = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    // Dirent with recursive may have path relative? Use parentPath or path
    const full = path.join(e.parentPath || e.path || dir, e.name);
    if (!full.endsWith(".md")) continue;
    if (path.basename(full).startsWith(".")) continue;
    const raw = fs.readFileSync(full, "utf8");
    const { data, body } = parseFrontmatter(raw);
    const normBody = normalizeBody(body);
    const h = hashStr(normBody);
    files.push({ fullPath: full, data, body, normBody, hash: h, raw });
  }
  return files;
}

function loadSyncState(dir) {
  const p = path.join(dir, ".substack-sync.json");
  if (!fs.existsSync(p)) return { version: 1, entries: {} };
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!j.entries) j.entries = {};
    return j;
  } catch {
    return { version: 1, entries: {} };
  }
}

function saveSyncState(dir, state) {
  const p = path.join(dir, ".substack-sync.json");
  fs.writeFileSync(p, JSON.stringify(state, null, 2), "utf8");
}

function updateFileFrontmatter(fullPath, patch) {
  const raw = fs.readFileSync(fullPath, "utf8");
  const { data, body } = parseFrontmatter(raw);
  const merged = { ...data, ...patch };
  const fmStr = stringifyFrontmatter(merged);
  const newRaw = fmStr + body;
  fs.writeFileSync(fullPath, newRaw, "utf8");
  return merged;
}

async function fetchRemoteMap({ sid, publicationUrl }) {
  // paginated fetch (limit 20 max per API, 100 is 400)
  async function fetchAll(fn) {
    const all = [];
    let offset = 0;
    const limit = 20;
    while (true) {
      const res = await fn({ sid, publicationUrl, offset, limit });
      const posts = res.posts || [];
      all.push(...posts);
      if (posts.length < limit) break;
      offset += limit;
      await new Promise((r) => setTimeout(r, 400));
    }
    return all;
  }
  const draftsPosts = await fetchAll(listDrafts);
  const publishedPosts = await fetchAll(listPublished);
  const map = new Map(); // id -> {remote, isPublished}
  for (const p of draftsPosts) {
    map.set(p.id, { id: p.id, title: p.draft_title || p.title, isPublished: false, raw: p, updatedAt: p.draft_updated_at });
  }
  for (const p of publishedPosts) {
    // published may overlap with drafts? Keep published flag
    if (map.has(p.id)) {
      const ex = map.get(p.id);
      ex.isPublished = true;
      ex.raw = p;
      ex.updatedAt = p.updated_at || p.post_date;
    } else {
      map.set(p.id, { id: p.id, title: p.title || p.draft_title, isPublished: true, raw: p, updatedAt: p.updated_at || p.post_date });
    }
  }
  return map;
}

function tiptapHashFromDraft(draft) {
  try {
    const rawBody = draft.draft_body || draft.body;
    let doc = null;
    if (typeof rawBody === "string") doc = JSON.parse(rawBody);
    else doc = rawBody;
    // For hashing, we convert to markdown without frontmatter and normalize
    // Use draftToMarkdown without frontmatter then normalize
    const md = draftToMarkdown(draft, { frontmatter: false });
    return hashStr(normalizeBody(md));
  } catch {
    return null;
  }
}

export async function syncFolder({
  sid,
  publicationUrl,
  dir,
  dryRun = false,
  yes = false,
  republish = false,
  pull = true,
  push = true,
}) {
  const absDir = path.resolve(dir);
  if (!fs.existsSync(absDir)) fs.mkdirSync(absDir, { recursive: true });
  const locals = scanLocal(absDir);
  const state = loadSyncState(absDir);
  const remoteMap = await fetchRemoteMap({ sid, publicationUrl });

  // Build local by id
  const localById = new Map(); // id -> localFile
  const localsWithoutId = [];
  for (const lf of locals) {
    const id = lf.data.id ? Number(lf.data.id) : null;
    if (id && remoteMap.has(id)) localById.set(id, lf);
    else if (id && !remoteMap.has(id)) {
      // id points to deleted remote -> treat as new (will create new draft)
      localsWithoutId.push(lf);
    } else {
      localsWithoutId.push(lf);
    }
  }

  // Also index locals by slug/title for matching remote without id?
  // For now, only id-based matching; files without id are new.

  const actions = [];
  const toCreate = [];
  const toUpdate = []; // {id, localFile, remote, isPublished}
  const toPull = [];
  const conflicts = [];

  // 1. Locals without id => create
  if (push) {
    for (const lf of localsWithoutId) {
      // If file has slug that matches a remote slug, we could match, but for now create
      // Check if title matches remote title exactly and remote not already matched? Heuristic disabled to avoid false matches
      toCreate.push(lf);
      actions.push({ type: "create", path: path.relative(absDir, lf.fullPath), title: lf.data.title || lf.body.match(/^#\s+(.+)$/m)?.[1] || path.basename(lf.fullPath) });
    }
  }

  // 2. Locals with id => check diff
  for (const [id, lf] of localById) {
    const remote = remoteMap.get(id);
    if (!remote) continue;
    // Get full remote draft to compare body
    // We'll fetch draft detail for each matched id (rate limited)
    // For now, defer fetching until needed, but we can fetch here with delay
  }

  // Fetch details for matched ids to compare
  const matchedIds = [...localById.keys()];
  const remoteDetails = new Map();
  for (let i = 0; i < matchedIds.length; i++) {
    const id = matchedIds[i];
    if (i > 0) await new Promise((r) => setTimeout(r, 400)); // throttle
    try {
      const detail = await getDraft({ sid, publicationUrl, id });
      remoteDetails.set(id, detail);
    } catch (e) {
      console.error(`  warn: could not fetch remote ${id}: ${e.message}`);
    }
  }

  for (const [id, lf] of localById) {
    const detail = remoteDetails.get(id);
    if (!detail) continue;
    const remote = remoteMap.get(id);
    const localHash = lf.hash;
    const remoteHash = tiptapHashFromDraft(detail);
    const stateEntry = state.entries[id];
    const lastHash = stateEntry?.lastHash;

    // If hashes equal, no change
    if (remoteHash && localHash === remoteHash) {
      // Also check if lastHash matches localHash to detect no change
      continue;
    }
    // If localHash differs from remoteHash, we have a change on at least one side
    // Determine direction via lastHash
    if (lastHash) {
      const localChanged = localHash !== lastHash;
      const remoteChanged = remoteHash !== lastHash;
      if (localChanged && remoteChanged) {
        conflicts.push({ id, path: path.relative(absDir, lf.fullPath), localHash, remoteHash, lastHash });
        actions.push({ type: "conflict", id, path: path.relative(absDir, lf.fullPath) });
        continue;
      } else if (localChanged) {
        toUpdate.push({ id, localFile: lf, remote: detail, isPublished: remote.isPublished });
        actions.push({ type: "update", id, path: path.relative(absDir, lf.fullPath), isPublished: remote.isPublished });
      } else if (remoteChanged) {
        // remote changed, local not -> pull
        if (pull) {
          toPull.push({ id, remote: detail });
          actions.push({ type: "pull", id, path: path.relative(absDir, lf.fullPath) });
        }
      } else {
        // both unchanged? but hashes differ -> treat as update (fallback)
        toUpdate.push({ id, localFile: lf, remote: detail, isPublished: remote.isPublished });
        actions.push({ type: "update", id, path: path.relative(absDir, lf.fullPath), isPublished: remote.isPublished });
      }
    } else {
      // No lastHash (first sync with existing id) -> compare local vs remote
      if (localHash !== remoteHash) {
        // Assume local is source if file exists; mark as update
        // But also could be remote-only? For now treat as update
        toUpdate.push({ id, localFile: lf, remote: detail, isPublished: remote.isPublished });
        actions.push({ type: "update", id, path: path.relative(absDir, lf.fullPath), isPublished: remote.isPublished });
      }
    }
  }

  // 3. Remote-only (not matched to local) => pull
  if (pull) {
    for (const [id, remote] of remoteMap) {
      if (!localById.has(id)) {
        // Check if any localWithoutId matches by title/slug? Skip for now
        // Also check if id already in toCreate? No
        // Only pull if not already scheduled for create
        const alreadyPulled = toPull.some((p) => p.id === id);
        if (alreadyPulled) continue;
        // Check if remote is already represented by a local file without id but with same title? Heuristic: if localsWithoutId has same title, skip pull to avoid duplicate
        const remoteTitle = remote.title || "";
        const hasLocalWithSameTitle = localsWithoutId.some((lf) => {
          const t = lf.data.title || lf.body.match(/^#\s+(.+)$/m)?.[1] || "";
          return t && remoteTitle && t.trim() === remoteTitle.trim();
        });
        if (hasLocalWithSameTitle) continue;
        toPull.push({ id, remote: remoteMap.get(id) }); // will fetch detail later
        // Need detail for pull; fetch if not already have
        if (!remoteDetails.has(id)) {
          // fetch detail now
          try {
            await new Promise((r) => setTimeout(r, 400));
            const detail = await getDraft({ sid, publicationUrl, id });
            remoteDetails.set(id, detail);
          } catch {}
        }
        actions.push({ type: "pull", id, title: remote.title });
      }
    }
  }

  // Summary
  const summary = {
    dir: absDir,
    publicationUrl,
    dryRun,
    toCreate: toCreate.length,
    toUpdate: toUpdate.length,
    toPull: toPull.length,
    conflicts: conflicts.length,
    actions,
  };

  if (dryRun) {
    return summary;
  }

  if (!yes && (toCreate.length || toUpdate.length || toPull.length)) {
    // Require --yes for actual writes
    summary.needsYes = true;
    return summary;
  }

  // Execute creates
  for (let i = 0; i < toCreate.length; i++) {
    const lf = toCreate[i];
    if (i > 0) await new Promise((r) => setTimeout(r, 800));
    console.error(`  creating ${path.relative(absDir, lf.fullPath)} ...`);
    const title = lf.data.title || lf.body.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.basename(lf.fullPath, ".md");
    const subtitle = lf.data.subtitle ? String(lf.data.subtitle) : "";
    const audience = lf.data.audience ? String(lf.data.audience) : "everyone";
    const baseDir = path.dirname(lf.fullPath);
    const res = await createDraft({ sid, publicationUrl, markdown: lf.body, title, subtitle, audience, baseDir });
    const newId = res.id;
    // update file frontmatter with id
    updateFileFrontmatter(lf.fullPath, { id: newId, slug: res.raw.slug || lf.data.slug, updated_at: new Date().toISOString() });
    // update sync state
    const newBody = normalizeBody(lf.body);
    state.entries[newId] = { path: path.relative(absDir, lf.fullPath), lastHash: hashStr(newBody), remoteUpdatedAt: res.raw.draft_updated_at, title };
    console.error(`  created id ${newId} for ${path.relative(absDir, lf.fullPath)}`);
  }

  // Execute updates (+ republish if needed)
  for (let i = 0; i < toUpdate.length; i++) {
    const { id, localFile, isPublished } = toUpdate[i];
    if (i > 0 || toCreate.length) await new Promise((r) => setTimeout(r, 800));
    console.error(`  updating ${path.relative(absDir, localFile.fullPath)} id ${id} ${isPublished ? "(published, will republish)" : "(draft)"} ...`);
    const title = localFile.data.title || localFile.body.match(/^#\s+(.+)$/m)?.[1]?.trim() || undefined;
    const subtitle = localFile.data.subtitle != null ? String(localFile.data.subtitle) : undefined;
    const audience = localFile.data.audience ? String(localFile.data.audience) : undefined;
    const baseDir = path.dirname(localFile.fullPath);
    await updateDraft({ sid, publicationUrl, id, markdown: localFile.body, title, subtitle, audience, baseDir });
    let republished = false;
    if (isPublished && republish) {
      await new Promise((r) => setTimeout(r, 800));
      await publishDraft({ sid, publicationUrl, id, send: false, shareAutomatically: false });
      republished = true;
    } else if (isPublished && !republish) {
      console.error(`  note: ${id} is published but --republish not set; draft updated but live post not yet republished. Run with --republish to push live.`);
    }
    // update sync state
    const newHash = localFile.hash;
    const detail = await getDraft({ sid, publicationUrl, id });
    state.entries[id] = { path: path.relative(absDir, localFile.fullPath), lastHash: newHash, remoteUpdatedAt: detail.draft_updated_at, title: detail.draft_title, republished };
    console.error(`  updated id ${id} ${republished ? "(republished live)" : ""}`);
  }

  // Execute pulls (resilient: skip failed drafts, keep going)
  for (let i = 0; i < toPull.length; i++) {
    const { id } = toPull[i];
    if (i > 0 || toCreate.length || toUpdate.length) await new Promise((r) => setTimeout(r, 600));
    console.error(`  pulling ${id} ...`);
    let detail;
    try {
      detail = remoteDetails.get(id) || await getDraft({ sid, publicationUrl, id });
    } catch (e) {
      console.error(`  warn: could not fetch ${id}: ${e.message} (skipping)`);
      continue;
    }
    let md;
    try {
      md = draftToMarkdown(detail, { frontmatter: true });
    } catch (e) {
      console.error(`  warn: could not convert ${id}: ${e.message} (skipping)`);
      continue;
    }
    // Determine file path: use slug or title
    let slug = detail.slug || detail.draft_title || `draft-${id}`;
    slug = String(slug).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || `draft-${id}`;
    // Avoid overwrite: if file exists with same id, skip; else create new file
    let outPath = path.join(absDir, `${slug}.md`);
    let counter = 1;
    while (fs.existsSync(outPath)) {
      const existing = fs.readFileSync(outPath, "utf8");
      const { data } = parseFrontmatter(existing);
      if (String(data.id) === String(id)) break; // same id, overwrite
      outPath = path.join(absDir, `${slug}-${counter}.md`);
      counter++;
    }
    fs.writeFileSync(outPath, md, "utf8");
    const { body } = parseFrontmatter(md);
    const h = hashStr(normalizeBody(body));
    state.entries[id] = { path: path.relative(absDir, outPath), lastHash: h, remoteUpdatedAt: detail.draft_updated_at, title: detail.draft_title };
    console.error(`  pulled ${id} -> ${path.relative(absDir, outPath)}`);
  }

  saveSyncState(absDir, state);
  return summary;
}
