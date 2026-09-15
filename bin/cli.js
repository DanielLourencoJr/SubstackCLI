#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { getSid } from "../lib/auth.js";
import { mdToTiptap } from "../lib/md.js";
import { parseFrontmatter } from "../lib/frontmatter.js";
import {
  createDraft,
  getDraft,
  updateDraft,
  deleteDraft,
  listDrafts,
  listPublished,
  listScheduled,
  prepublishDraft,
  publishDraft,
  scheduleDraft,
  unscheduleDraft,
  getCounts,
} from "../lib/drafts.js";

const VERSION = "0.1.0";

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        out.flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const nxt = argv[i + 1];
        if (nxt && !nxt.startsWith("-")) {
          out.flags[key] = nxt;
          i++;
        } else {
          out.flags[key] = true;
        }
      }
    } else if (a.startsWith("-") && a.length === 2) {
      const key = a.slice(1);
      const nxt = argv[i + 1];
      if (nxt && !nxt.startsWith("-")) {
        out.flags[key] = nxt;
        i++;
      } else {
        out.flags[key] = true;
      }
    } else {
      out._.push(a);
    }
    i++;
  }
  return out;
}

function getPub(flags) {
  return flags["pub"] || flags["publication-url"] || flags["p"] || process.env.SUBSTACK_PUB || "danielloureno.substack.com";
}

function help() {
  console.log(`substack-cli v${VERSION} — upload/manage Substack drafts

Usage:
  substack-cli drafts create <file.md> [options]
  substack-cli drafts list [--limit N] [--offset N] [--pub host] [--json] [--env file]
  substack-cli drafts get <id> [--pub host] [--json]
  substack-cli drafts update <id> <file.md> [--title t] [--subtitle s] [--pub host]
  substack-cli drafts delete <id> [--pub host] [--yes] [--json]
  substack-cli drafts publish <id> [--send|--no-send] [--yes] [--pub host] [--json]
  substack-cli drafts schedule <id> --at <ISO8601> [--pub host]
  substack-cli drafts unschedule <id> [--pub host]
  substack-cli drafts export <id> [--output file.md] [--md-dir dir] [--pub host] [--json]
  substack-cli sync [--dir ./Articles] [--pub host] [--env file] [--dry-run] [--yes] [--republish] [--no-pull] [--no-push] [--json]
  substack-cli drafts counts [--pub host] [--json]
  substack-cli published list [--limit N] [--offset N] [--pub host] [--json]
  substack-cli scheduled list [--limit N] [--pub host] [--json]

Global options:
  --pub <host>            publication host e.g. danielloureno.substack.com (alias --publication-url)
  --env <file>            .env file with SUBSTACK_SID
  --sid <token>           override SID directly
  --json                  JSON output
  --dry-run               (create only) show payload without POST

Examples:
  substack-cli drafts create post.md --pub danielloureno.substack.com
  substack-cli drafts list --limit 10 --json
  substack-cli drafts publish 123 --no-send --yes
`);
}

function needSid(flags) {
  const envFile = flags["env"] || flags["e"] || null;
  const sidFlag = flags["sid"] || null;
  return getSid({ envFile, token: sidFlag });
}

async function cmdDraftsCreate(rest, flags) {
  const { _, flags: f } = parseArgs(rest);
  const file = _[0];
  const pub = getPub({ ...flags, ...f });
  const wantJson = !!(flags["json"] || f["json"]);
  const dryRun = !!(flags["dry-run"] || f["dry-run"]);
  const audience = f["audience"] || flags["audience"] || "everyone";
  let title = f["title"] || flags["title"] || null;
  let subtitle = f["subtitle"] || flags["subtitle"] || null;
  const sidOverride = f["sid"] || flags["sid"] || null;
  const envFile = f["env"] || flags["env"] || null;

  if (!file && !dryRun) {
    console.error("Missing <file.md>");
    process.exit(1);
  }
  let markdown = "";
  let fmData = {};
  if (file) {
    if (!fs.existsSync(file)) { console.error(`File not found: ${file}`); process.exit(1); }
    markdown = fs.readFileSync(file, "utf8");
    const parsed = parseFrontmatter(markdown);
    fmData = parsed.data;
    markdown = parsed.body;
    // frontmatter overrides (CLI flags take precedence)
    if (!title && fmData.title) title = String(fmData.title);
    if (!subtitle && fmData.subtitle) subtitle = String(fmData.subtitle);
    // audience from frontmatter if not set via flag
    if ((f["audience"] == null && flags["audience"] == null) && fmData.audience) {
      // will be handled below via fmData
    }
    if (!title) {
      const m = markdown.match(/^#\s+(.+)$/m);
      if (m) title = m[1].trim();
      else title = path.basename(file, path.extname(file));
    }
  } else if (dryRun) {
    markdown = f["markdown"] || "# Dry run\n\nHello.";
    title = title || "Dry run";
  }
  // audience: CLI > frontmatter > default
  const fmAudience = fmData.audience ? String(fmData.audience) : null;
  const finalAudience = audience !== "everyone" ? audience : (fmAudience || "everyone");
  if (!markdown.trim()) { console.error("Markdown is empty"); process.exit(1); }

  if (dryRun) {
    const doc = mdToTiptap(markdown);
    const payload = { draft_title: title, draft_subtitle: subtitle || "", draft_body: JSON.stringify(doc), type: "newsletter", audience: finalAudience, draft_bylines: [] };
    if (wantJson) console.log(JSON.stringify({ dryRun: true, pub, payload, tiptap: doc }, null, 2));
    else { console.log(`[dry-run] pub=${pub} title="${title}" nodes=${doc.content.length} bytes=${Buffer.byteLength(payload.draft_body, "utf8")}`); console.log(JSON.stringify(payload, null, 2).slice(0, 2000)); }
    return;
  }

  const sid = needSid({ ...flags, ...f, env: envFile, sid: sidOverride });
  try {
    const baseDir = file ? path.dirname(path.resolve(file)) : ".";
    const res = await createDraft({ sid, publicationUrl: pub, markdown, title, subtitle, audience: finalAudience, baseDir });
    const url = `https://${pub.replace(/^https?:\/\//, "").replace(/\/+$/, "")}/publish/post/${res.id}`;
    if (wantJson) console.log(JSON.stringify({ id: res.id, url, title, pub, raw: res.raw }, null, 2));
    else { console.log(`✅ Draft created: id=${res.id}`); console.log(`   Title: ${title}`); console.log(`   URL:   ${url}`); console.log(`   Pub:   ${pub}`); }
  } catch (e) {
    console.error(`❌ drafts create failed: ${e.message}`);
    if (wantJson) console.log(JSON.stringify({ error: e.message }, null, 2));
    process.exit(1);
  }
}

async function cmdDraftsList(rest, flags) {
  const { flags: f } = parseArgs(rest);
  const pub = getPub({ ...flags, ...f });
  const limit = parseInt(f["limit"] || flags["limit"] || "20", 10);
  const offset = parseInt(f["offset"] || flags["offset"] || "0", 10);
  const wantJson = !!(f["json"] || flags["json"]);
  const sid = needSid({ ...flags, ...f });
  try {
    const data = await listDrafts({ sid, publicationUrl: pub, offset, limit });
    if (wantJson) console.log(JSON.stringify(data, null, 2));
    else {
      const posts = data.posts || data.drafts || [];
      console.log(`Drafts (offset=${offset} limit=${limit} total=${data.total ?? posts.length}):`);
      for (const p of posts) {
        const id = p.id;
        const title = p.draft_title || p.title || "(no title)";
        const upd = p.draft_updated_at || p.updated_at || "";
        console.log(`  ${id}  ${title}  [${upd.slice(0,10)}]`);
      }
      if (!posts.length) console.log("  (no drafts)");
    }
  } catch (e) { console.error(`❌ drafts list failed: ${e.message}`); process.exit(1); }
}

async function cmdDraftsGet(rest, flags) {
  const { _, flags: f } = parseArgs(rest);
  const id = _[0] || f["id"] || flags["id"];
  if (!id) { console.error("Missing <id>"); process.exit(1); }
  const pub = getPub({ ...flags, ...f });
  const wantJson = !!(f["json"] || flags["json"]);
  const sid = needSid({ ...flags, ...f });
  try {
    const data = await getDraft({ sid, publicationUrl: pub, id });
    if (wantJson) console.log(JSON.stringify(data, null, 2));
    else {
      console.log(`Draft ${id}:`);
      console.log(`  Title: ${data.draft_title || data.title}`);
      console.log(`  Subtitle: ${data.draft_subtitle || ""}`);
      console.log(`  Updated: ${data.draft_updated_at}`);
      console.log(`  Body preview: ${(data.draft_body || "").slice(0, 300)}`);
    }
  } catch (e) { console.error(`❌ drafts get failed: ${e.message}`); process.exit(1); }
}

async function cmdDraftsUpdate(rest, flags) {
  const { _, flags: f } = parseArgs(rest);
  const id = _[0];
  const file = _[1];
  if (!id || !file) { console.error("Usage: drafts update <id> <file.md>"); process.exit(1); }
  const pub = getPub({ ...flags, ...f });
  const wantJson = !!(f["json"] || flags["json"]);
  const sid = needSid({ ...flags, ...f });
  if (!fs.existsSync(file)) { console.error(`File not found: ${file}`); process.exit(1); }
  let markdown = fs.readFileSync(file, "utf8");
  const parsed = parseFrontmatter(markdown);
  markdown = parsed.body;
  let title = f["title"] || flags["title"] || null;
  let subtitle = f["subtitle"] || flags["subtitle"] || null;
  let audience = f["audience"] || flags["audience"] || undefined;
  if (!title && parsed.data.title) title = String(parsed.data.title);
  if (!subtitle && parsed.data.subtitle) subtitle = String(parsed.data.subtitle);
  if (!audience && parsed.data.audience) audience = String(parsed.data.audience);
  const baseDir = path.dirname(path.resolve(file));
  try {
    const data = await updateDraft({ sid, publicationUrl: pub, id, markdown, title, subtitle, audience, baseDir });
    if (wantJson) console.log(JSON.stringify(data, null, 2));
    else console.log(`✅ Draft ${id} updated: title="${data.draft_title || title}"`);
  } catch (e) { console.error(`❌ drafts update failed: ${e.message}`); process.exit(1); }
}

async function cmdDraftsDelete(rest, flags) {
  const { _, flags: f } = parseArgs(rest);
  const id = _[0];
  if (!id) { console.error("Missing <id>"); process.exit(1); }
  const pub = getPub({ ...flags, ...f });
  const wantJson = !!(f["json"] || flags["json"]);
  const yes = !!(f["yes"] || flags["yes"]);
  if (!yes && !wantJson) {
    // simple guard: require --yes unless interactive? Keep lenient for now
    // but warn
    console.log(`⚠ Deleting draft ${id} on ${pub}. Use --yes to confirm.`);
  }
  const sid = needSid({ ...flags, ...f });
  try {
    await deleteDraft({ sid, publicationUrl: pub, id });
    if (wantJson) console.log(JSON.stringify({ deleted: true, id: Number(id) }, null, 2));
    else console.log(`✅ Draft ${id} deleted`);
  } catch (e) { console.error(`❌ drafts delete failed: ${e.message}`); process.exit(1); }
}

async function cmdDraftsPublish(rest, flags) {
  const { _, flags: f } = parseArgs(rest);
  const id = _[0];
  if (!id) { console.error("Missing <id>"); process.exit(1); }
  const pub = getPub({ ...flags, ...f });
  const wantJson = !!(f["json"] || flags["json"]);
  const yes = !!(f["yes"] || flags["yes"] || f["y"]);
  // send handling: --send => true, --no-send => false, default false for safety
  let send = false;
  if (f["send"] || flags["send"]) send = true;
  if (f["no-send"] || flags["no-send"] || f["noSend"]) send = false;
  // explicit --send=false
  if (f["send"] === "false" || flags["send"] === "false") send = false;

  if (!yes) {
    console.error(`⚠ Publishing is irreversible${send ? " and will email subscribers" : " (silent)"}. Add --yes to confirm.`);
    process.exit(1);
  }
  const sid = needSid({ ...flags, ...f });
  try {
    const pre = await prepublishDraft({ sid, publicationUrl: pub, id });
    if (pre.errors && pre.errors.length) {
      console.error(`Prepublish errors: ${JSON.stringify(pre.errors)}`);
      if (!wantJson) process.exit(1);
    }
    if (pre.suggestions && pre.suggestions.length && !wantJson) {
      console.log(`Suggestions: ${JSON.stringify(pre.suggestions)}`);
    }
    const data = await publishDraft({ sid, publicationUrl: pub, id, send, shareAutomatically: false });
    const url = `https://${pub.replace(/^https?:\/\//, "").replace(/\/+$/, "")}/p/${data.slug || data.post?.slug || ""}`;
    if (wantJson) console.log(JSON.stringify({ published: true, id: Number(id), send, slug: data.slug, url, raw: data }, null, 2));
    else { console.log(`✅ Draft ${id} published${send ? " (emailed)" : " (silent, --no-send)"}`); console.log(`   Slug: ${data.slug}`); console.log(`   URL: ${url}`); }
  } catch (e) { console.error(`❌ drafts publish failed: ${e.message}`); process.exit(1); }
}

async function cmdDraftsSchedule(rest, flags) {
  const { _, flags: f } = parseArgs(rest);
  const id = _[0];
  if (!id) { console.error("Missing <id>"); process.exit(1); }
  const at = f["at"] || flags["at"];
  if (!at) { console.error("Missing --at <ISO8601> e.g. 2026-09-20T09:00:00+02:00"); process.exit(1); }
  const pub = getPub({ ...flags, ...f });
  const sid = needSid({ ...flags, ...f });
  const audience = f["audience"] || flags["audience"] || "everyone";
  try {
    const data = await scheduleDraft({ sid, publicationUrl: pub, id, triggerAt: at, postAudience: audience });
    console.log(JSON.stringify(data, null, 2));
  } catch (e) { console.error(`❌ schedule failed: ${e.message}`); process.exit(1); }
}

async function cmdDraftsUnschedule(rest, flags) {
  const { _, flags: f } = parseArgs(rest);
  const id = _[0];
  if (!id) { console.error("Missing <id>"); process.exit(1); }
  const pub = getPub({ ...flags, ...f });
  const sid = needSid({ ...flags, ...f });
  try {
    const data = await unscheduleDraft({ sid, publicationUrl: pub, id });
    console.log(JSON.stringify(data, null, 2));
  } catch (e) { console.error(`❌ unschedule failed: ${e.message}`); process.exit(1); }
}

async function cmdDraftsCounts(rest, flags) {
  const { flags: f } = parseArgs(rest);
  const pub = getPub({ ...flags, ...f });
  const wantJson = !!(f["json"] || flags["json"]);
  const sid = needSid({ ...flags, ...f });
  try {
    const data = await getCounts({ sid, publicationUrl: pub });
    if (wantJson) console.log(JSON.stringify(data, null, 2));
    else console.log(`Counts: published=${data.published} drafts=${data.drafts} scheduled=${data.scheduled}`);
  } catch (e) { console.error(`❌ counts failed: ${e.message}`); process.exit(1); }
}

async function cmdPublishedList(rest, flags) {
  const { flags: f } = parseArgs(rest);
  const pub = getPub({ ...flags, ...f });
  const limit = parseInt(f["limit"] || flags["limit"] || "20", 10);
  const offset = parseInt(f["offset"] || flags["offset"] || "0", 10);
  const wantJson = !!(f["json"] || flags["json"]);
  const sid = needSid({ ...flags, ...f });
  try {
    const data = await listPublished({ sid, publicationUrl: pub, offset, limit });
    if (wantJson) console.log(JSON.stringify(data, null, 2));
    else {
      const posts = data.posts || [];
      console.log(`Published (offset=${offset} limit=${limit} total=${data.total ?? posts.length}):`);
      for (const p of posts) {
        console.log(`  ${p.id}  ${p.title || p.post_title}  [${(p.post_date||"").slice(0,10)}] slug=${p.slug}`);
      }
      if (!posts.length) console.log("  (none)");
    }
  } catch (e) { console.error(`❌ published list failed: ${e.message}`); process.exit(1); }
}

async function cmdScheduledList(rest, flags) {
  const { flags: f } = parseArgs(rest);
  const pub = getPub({ ...flags, ...f });
  const limit = parseInt(f["limit"] || flags["limit"] || "20", 10);
  const offset = parseInt(f["offset"] || flags["offset"] || "0", 10);
  const wantJson = !!(f["json"] || flags["json"]);
  const sid = needSid({ ...flags, ...f });
  try {
    const data = await listScheduled({ sid, publicationUrl: pub, offset, limit });
    if (wantJson) console.log(JSON.stringify(data, null, 2));
    else {
      const posts = data.posts || [];
      console.log(`Scheduled (offset=${offset} limit=${limit} total=${data.total ?? posts.length}):`);
      for (const p of posts) console.log(`  ${p.id}  ${p.draft_title}`);
      if (!posts.length) console.log("  (none)");
    }
  } catch (e) { console.error(`❌ scheduled list failed: ${e.message}`); process.exit(1); }
}

async function cmdSync(rest, flags) {
  const { _, flags: f } = parseArgs(rest);
  // dir from first positional or --dir
  const dirFromPos = _[0];
  const dir = f["dir"] || flags["dir"] || dirFromPos || "./Articles";
  const pub = getPub({ ...flags, ...f });
  const wantJson = !!(f["json"] || flags["json"]);
  const dryRun = !!(f["dry-run"] || flags["dry-run"] || f["dryRun"]);
  const yes = !!(f["yes"] || flags["yes"] || f["y"]);
  const republish = !!(f["republish"] || flags["republish"]);
  const noPull = !!(f["no-pull"] || flags["no-pull"]);
  const noPush = !!(f["no-push"] || flags["no-push"]);
  const sid = needSid({ ...flags, ...f });
  const { syncFolder } = await import("../lib/sync.js");
  try {
    const res = await syncFolder({
      sid,
      publicationUrl: pub,
      dir,
      dryRun,
      yes,
      republish,
      pull: !noPull,
      push: !noPush,
    });
    if (wantJson) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      if (dryRun) console.log(`[dry-run] dir=${res.dir} pub=${publicationUrlDisplay(pub)}`);
      else if (res.needsYes) console.log(`[sync] --yes required to apply ${res.actions.length} action(s)`);
      else console.log(`[sync] done dir=${res.dir} pub=${publicationUrlDisplay(pub)}`);
      if (res.actions.length === 0) console.log("  (no changes)");
      else {
        for (const a of res.actions) {
          if (a.type === "create") console.log(`  + create ${a.path} title="${a.title}"`);
          else if (a.type === "update") console.log(`  ~ update ${a.path} id=${a.id}${a.isPublished ? " (published)" : ""}`);
          else if (a.type === "pull") console.log(`  - pull id=${a.id} ${a.title ? `title="${a.title}"` : a.path ? `path=${a.path}` : ""}`);
          else if (a.type === "conflict") console.log(`  ! conflict id=${a.id} ${a.path} (local and remote both changed)`);
        }
        console.log(`  summary: create=${res.toCreate} update=${res.toUpdate} pull=${res.toPull} conflict=${res.conflicts}`);
        if (!dryRun && !yes && res.actions.length) console.log(`  run with --yes to apply`);
        if (res.conflicts && res.conflicts > 0) console.log(`  conflicts need manual resolution`);
      }
    }
  } catch (e) {
    console.error(`❌ sync failed: ${e.message}`);
    if (e.stack) console.error(e.stack.split("\n").slice(1, 4).join("\n"));
    process.exit(1);
  }
}

function publicationUrlDisplay(pub) {
  return pub.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

async function cmdDraftsExport(rest, flags) {
  const { _, flags: f } = parseArgs(rest);
  const id = _[0];
  if (!id) { console.error("Missing <id>"); process.exit(1); }
  const pub = getPub({ ...flags, ...f });
  const wantJson = !!(f["json"] || flags["json"]);
  const output = f["output"] || f["o"] || flags["output"] || null;
  const mdDir = f["md-dir"] || flags["md-dir"] || null;
  const sid = needSid({ ...flags, ...f });
  try {
    const { draftToMarkdown } = await import("../lib/convert.js");
    const data = await getDraft({ sid, publicationUrl: pub, id });
    const md = draftToMarkdown(data, { frontmatter: true });
    const unsupported = []; // collect opaque nodes already encoded in md as comments
    if (wantJson) {
      console.log(JSON.stringify({ id: Number(id), markdown: md, draft: data }, null, 2));
    } else if (mdDir) {
      // mdDir layout like SubstackKit: <mdDir>/Articles/<slug>.md
      const slug = (data.slug || data.draft_title || `draft-${id}`).replace(/[^a-z0-9\-]/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || `draft-${id}`;
      const dir = path.join(mdDir, "Articles");
      fs.mkdirSync(dir, { recursive: true });
      const outPath = path.join(dir, `${slug}.md`);
      fs.writeFileSync(outPath, md, "utf8");
      console.log(`✅ Exported ${id} → ${outPath}`);
    } else if (output) {
      fs.writeFileSync(output, md, "utf8");
      console.log(`✅ Exported ${id} → ${output}`);
    } else {
      console.log(md);
    }
  } catch (e) { console.error(`❌ drafts export failed: ${e.message}`); process.exit(1); }
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes("--help") || argv.includes("-h") || argv[0] === "help") { help(); return; }

  // global flags are those before subcommand? Simplify: parse whole argv for global
  const { _, flags: globalFlags } = parseArgs(argv);
  // _. contains positional commands: e.g. ["drafts","create", "file.md"]
  const [ns, cmd, ...rest] = _;

  // published namespace
  if (ns === "published" && cmd === "list") return cmdPublishedList(rest, globalFlags);
  if (ns === "scheduled" && cmd === "list") return cmdScheduledList(rest, globalFlags);

  if (ns === "sync" && (!cmd || cmd === "--help" || cmd === "-h")) return cmdSync([], globalFlags);
  if (ns === "sync") return cmdSync([cmd, ...rest], globalFlags);
  if (ns !== "drafts") { console.error(`Unknown command: ${ns} ${cmd}`); help(); process.exit(1); }

  if (cmd === "create") return cmdDraftsCreate(rest, globalFlags);
  if (cmd === "list") return cmdDraftsList(rest, globalFlags);
  if (cmd === "get") return cmdDraftsGet(rest, globalFlags);
  if (cmd === "update") return cmdDraftsUpdate(rest, globalFlags);
  if (cmd === "delete") return cmdDraftsDelete(rest, globalFlags);
  if (cmd === "publish") return cmdDraftsPublish(rest, globalFlags);
  if (cmd === "schedule") return cmdDraftsSchedule(rest, globalFlags);
  if (cmd === "unschedule") return cmdDraftsUnschedule(rest, globalFlags);
  if (cmd === "export") return cmdDraftsExport(rest, globalFlags);
  if (cmd === "counts") return cmdDraftsCounts(rest, globalFlags);

  console.error(`Unknown drafts command: ${cmd}`);
  help();
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
