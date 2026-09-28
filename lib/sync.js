import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter.js";
import { draftToMarkdown } from "./convert.js";
import {
  createDraft,
  getDraft,
  updateDraft,
  publishDraft,
  listDrafts,
  listPublished,
  translateDraft,
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
    // Keep remote list boundaries visible to the diff. User-facing exports merge
    // adjacent ordered lists, but doing so here would hide the structural update
    // sync is meant to apply.
    const md = draftToMarkdown(draft, { frontmatter: false, mergeAdjacentOrderedLists: false });
    return hashStr(normalizeBody(md));
  } catch {
    return null;
  }
}

function editionKey(id, language = null) {
  return language ? `${id}::${language}` : `${id}::original`;
}

function stateKey(id, language = null) {
  return language ? `${id}:${language}` : String(id);
}

function slugFor(detail, id) {
  const source = detail.slug || detail.draft_title || detail.title || `draft-${id}`;
  return String(source).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || `draft-${id}`;
}

function organizedRelativePath(record) {
  const status = record.isPublished ? "Published" : "Drafts";
  const editionDir = record.language
    ? path.join("Translations", record.language)
    : "Originals";
  return path.join(status, editionDir, `${slugFor(record.base, record.id)}.md`);
}

function editionToMarkdown(record) {
  const source = record.language
    ? {
        ...record.edition,
        id: record.id,
        publication_id: record.base.publication_id,
        audience: record.base.audience,
      }
    : record.base;
  const body = draftToMarkdown(source, { frontmatter: false });
  const metadata = {
    title: source.draft_title || source.title || record.base.draft_title || record.base.title || "",
    subtitle: source.draft_subtitle || source.subtitle || "",
    slug: record.base.slug || undefined,
    audience: record.base.audience || "everyone",
    id: record.id,
    edition: record.language ? "translation" : "original",
    language: record.language || record.base.language || undefined,
    publication_id: record.base.publication_id,
  };
  for (const key of Object.keys(metadata)) if (metadata[key] == null || metadata[key] === "") delete metadata[key];
  return stringifyFrontmatter(metadata) + body;
}

function localEditionKey(file) {
  const id = file.data.id ? Number(file.data.id) : null;
  if (!id) return null;
  const isTranslation = file.data.edition === "translation" || file.data.translation === true;
  const language = isTranslation ? String(file.data.language || "").toLowerCase() : null;
  if (isTranslation && !language) return null;
  return editionKey(id, language);
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
  if (!fs.existsSync(absDir) && !dryRun) fs.mkdirSync(absDir, { recursive: true });
  const locals = scanLocal(absDir);
  const state = loadSyncState(absDir);
  const remoteMap = await fetchRemoteMap({ sid, publicationUrl });
  const localByEdition = new Map();
  const unkeyed = [];
  const duplicateLocalKeys = new Set();
  for (const file of locals) {
    const key = localEditionKey(file);
    if (!key) { unkeyed.push(file); continue; }
    if (localByEdition.has(key)) duplicateLocalKeys.add(key);
    else localByEdition.set(key, file);
  }

  const actions = [];
  const toCreate = [];
  const toUpdate = []; // {id, localFile, remote, isPublished}
  const toPull = [];
  const conflicts = [];
  const untracked = [];

  if (push) {
    for (const file of unkeyed) {
      const isTranslation = file.data.edition === "translation" || file.data.translation === true;
      if (isTranslation) {
        actions.push({ type: "conflict", path: path.relative(absDir, file.fullPath), reason: "translation file is missing a valid post id or language" });
        conflicts.push({ path: path.relative(absDir, file.fullPath) });
      } else {
        toCreate.push(file);
        actions.push({ type: "create", path: path.relative(absDir, file.fullPath), title: file.data.title || file.body.match(/^#\s+(.+)$/m)?.[1] || path.basename(file.fullPath) });
      }
    }
  }

  for (const file of locals) {
    const id = file.data.id ? Number(file.data.id) : null;
    if (id && !remoteMap.has(id)) untracked.push(file);
  }

  // Pull full post data once per id. The detail includes any custom language editions.
  const remoteDetails = new Map();
  const remoteRecords = new Map();
  const allIds = [...remoteMap.keys()];
  for (let i = 0; i < allIds.length; i++) {
    const id = allIds[i];
    if (i > 0) await new Promise((r) => setTimeout(r, 400));
    try {
      const detail = await getDraft({ sid, publicationUrl, id });
      remoteDetails.set(id, detail);
      const summary = remoteMap.get(id);
      const baseRecord = { id, language: null, edition: null, base: detail, isPublished: summary.isPublished };
      remoteRecords.set(editionKey(id), baseRecord);
      for (const edition of detail.post_translations || []) {
        if (!edition.language) continue;
        const lang = String(edition.language).toLowerCase();
        remoteRecords.set(editionKey(id, lang), { id, language: lang, edition, base: detail, isPublished: summary.isPublished });
      }
    } catch (e) {
      console.error(`  warn: could not fetch remote ${id}: ${e.message}`);
    }
  }

  for (const [key, record] of remoteRecords) {
    const local = localByEdition.get(key);
    const remoteHash = tiptapHashFromDraft(record.language ? record.edition : record.base);
    const targetRelative = organizedRelativePath(record);
    const targetPath = path.join(absDir, targetRelative);
    if (!local) {
      if (pull) {
        const task = { key, record, oldPath: null, targetPath };
        toPull.push(task);
        actions.push({ type: "pull", id: record.id, language: record.language || undefined, path: targetRelative, title: record.language ? record.edition.draft_title : record.base.draft_title });
      }
      continue;
    }
    if (duplicateLocalKeys.has(key)) {
      conflicts.push({ id: record.id, language: record.language, path: path.relative(absDir, local.fullPath), reason: "multiple local files represent this edition" });
      actions.push({ type: "conflict", id: record.id, language: record.language, path: path.relative(absDir, local.fullPath) });
      continue;
    }
    const keyForState = stateKey(record.id, record.language);
    const stateEntry = state.entries[keyForState] || (!record.language ? state.entries[String(record.id)] : null);
    const lastHash = stateEntry?.lastHash;
    const localChanged = lastHash ? local.hash !== lastHash : local.hash !== remoteHash;
    const remoteChanged = lastHash ? remoteHash !== lastHash : local.hash !== remoteHash;

    if (local.hash === remoteHash) {
      if (path.relative(absDir, local.fullPath) !== targetRelative) {
        toPull.push({ key, record, oldPath: local.fullPath, targetPath, reason: "organize" });
        actions.push({ type: "move", id: record.id, language: record.language || undefined, from: path.relative(absDir, local.fullPath), path: targetRelative });
      }
      continue;
    }
    if (localChanged && remoteChanged) {
      conflicts.push({ id: record.id, language: record.language, path: path.relative(absDir, local.fullPath), localHash: local.hash, remoteHash, lastHash });
      actions.push({ type: "conflict", id: record.id, language: record.language, path: path.relative(absDir, local.fullPath) });
    } else if (localChanged) {
      if (push && record.isPublished && record.language) {
        conflicts.push({ id: record.id, language: record.language, path: path.relative(absDir, local.fullPath), reason: "updating published language editions is not supported by the CLI" });
        actions.push({ type: "conflict", id: record.id, language: record.language, path: path.relative(absDir, local.fullPath) });
      } else if (push) {
        toUpdate.push({ key, record, localFile: local, targetPath });
        actions.push({ type: "update", id: record.id, language: record.language || undefined, path: path.relative(absDir, local.fullPath), isPublished: record.isPublished });
      } else {
        conflicts.push({ id: record.id, language: record.language, path: path.relative(absDir, local.fullPath), reason: "local changes are pending but --no-push is set" });
        actions.push({ type: "conflict", id: record.id, language: record.language, path: path.relative(absDir, local.fullPath) });
      }
    } else if (remoteChanged && pull) {
      toPull.push({ key, record, oldPath: local.fullPath, targetPath, reason: "remote-update" });
      actions.push({ type: "pull", id: record.id, language: record.language || undefined, path: targetRelative, title: record.language ? record.edition.draft_title : record.base.draft_title });
    }
  }

  // Files with IDs absent from Substack are preserved and never treated as new posts.
  for (const file of untracked) {
    actions.push({ type: "orphan", id: Number(file.data.id), path: path.relative(absDir, file.fullPath) });
  }

  // Summary
  const summary = {
    dir: absDir,
    publicationUrl,
    dryRun,
    toCreate: toCreate.length,
    toUpdate: toUpdate.length,
    toPull: toPull.filter((task) => task.reason !== "organize").length,
    toMove: toPull.filter((task) => task.reason === "organize").length,
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
    const { key, record, localFile, targetPath } = toUpdate[i];
    const { id, language, isPublished } = record;
    if (i > 0 || toCreate.length) await new Promise((r) => setTimeout(r, 800));
    console.error(`  updating ${path.relative(absDir, localFile.fullPath)} id ${id}${language ? ` language=${language}` : ""} ...`);
    const title = localFile.data.title || localFile.body.match(/^#\s+(.+)$/m)?.[1]?.trim() || undefined;
    const subtitle = localFile.data.subtitle != null ? String(localFile.data.subtitle) : undefined;
    const baseDir = path.dirname(localFile.fullPath);
    if (language) {
      await translateDraft({ sid, publicationUrl, id, language, markdown: localFile.body, title, subtitle, baseDir });
    } else {
      const audience = localFile.data.audience ? String(localFile.data.audience) : undefined;
      await updateDraft({ sid, publicationUrl, id, markdown: localFile.body, title, subtitle, audience, baseDir });
    }
    let republished = false;
    if (isPublished && republish && !language) {
      await new Promise((r) => setTimeout(r, 800));
      await publishDraft({ sid, publicationUrl, id, send: false, shareAutomatically: false });
      republished = true;
    } else if (isPublished && !republish && !language) {
      console.error(`  note: ${id} is published but --republish not set; draft updated but live post not yet republished. Run with --republish to push live.`);
    }
    if (localFile.fullPath !== targetPath) {
      const md = editionToMarkdown(record);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, md, "utf8");
      fs.unlinkSync(localFile.fullPath);
    }
    // update sync state using separate keys for each translation
    const newHash = localFile.hash;
    const detail = await getDraft({ sid, publicationUrl, id });
    const savedEdition = language ? (detail.post_translations || []).find((item) => item.language === language) : detail;
    state.entries[stateKey(id, language)] = { path: path.relative(absDir, targetPath), lastHash: newHash, remoteUpdatedAt: detail.draft_updated_at, title: savedEdition?.draft_title || detail.draft_title, republished };
    console.error(`  updated id ${id} ${republished ? "(republished live)" : ""}`);
  }

  // Execute pulls (resilient: skip failed drafts, keep going)
  for (let i = 0; i < toPull.length; i++) {
    const { key, record, oldPath, targetPath } = toPull[i];
    const { id, language } = record;
    if (i > 0 || toCreate.length || toUpdate.length) await new Promise((r) => setTimeout(r, 600));
    console.error(`  pulling ${id}${language ? ` language=${language}` : ""} ...`);
    const detail = remoteDetails.get(id) || record.base;
    let md;
    try {
      md = editionToMarkdown(record);
    } catch (e) {
      console.error(`  warn: could not convert ${id}: ${e.message} (skipping)`);
      continue;
    }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    let outPath = targetPath;
    if (fs.existsSync(outPath)) {
      const existing = parseFrontmatter(fs.readFileSync(outPath, "utf8")).data;
      const existingKey = localEditionKey({ data: existing });
      if (existingKey && existingKey !== key) outPath = targetPath.replace(/\.md$/, `-${id}.md`);
    }
    fs.writeFileSync(outPath, md, "utf8");
    if (oldPath && oldPath !== outPath && fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    const { body, data } = parseFrontmatter(md);
    const h = hashStr(normalizeBody(body));
    state.entries[stateKey(id, language)] = { path: path.relative(absDir, outPath), lastHash: h, remoteUpdatedAt: detail.draft_updated_at, title: data.title };
    console.error(`  pulled ${id}${language ? ` language=${language}` : ""} -> ${path.relative(absDir, outPath)}`);
  }

  saveSyncState(absDir, state);
  return summary;
}
