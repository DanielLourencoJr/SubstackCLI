#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSid } from "../lib/auth.js";
import { mdToTiptap } from "../lib/md.js";
import { createDraft } from "../lib/drafts.js";

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

function help() {
  console.log(`substack-cli v${VERSION} — upload/manage Substack drafts

Usage:
  substack-cli drafts create <file.md> [options]

Options:
  --pub <host>            publication host, e.g. danielloureno.substack.com (or --publication-url)
  --publication-url <url> alias for --pub
  --title <str>           override title (default: first # heading or filename)
  --subtitle <str>        subtitle
  --audience <str>        everyone | only_paid (default everyone)
  --env <file>            .env file with SUBSTACK_SID (default .env + /mnt/HD/Junior/Projects/.substack.test.env)
  --sid <token>           override SID directly
  --json                  JSON output {id, url}
  --dry-run               show payload without POST
  --help, -h              this help

Examples:
  substack-cli drafts create post.md --pub danielloureno.substack.com
  substack-cli drafts create post.md --title "Hello" --subtitle "Sub" --dry-run --json
`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    help();
    return;
  }

  const [ns, cmd, ...rest] = argv;
  if (ns !== "drafts" || cmd !== "create") {
    console.error(`Unknown command: ${ns} ${cmd}\n`);
    help();
    process.exit(1);
  }

  const { _, flags } = parseArgs(rest);
  const file = _[0];
  if (!file && !flags["dry-run"]) {
    console.error("Missing <file.md> argument");
    help();
    process.exit(1);
  }

  const pub = flags["pub"] || flags["publication-url"] || flags["p"] || process.env.SUBSTACK_PUB || "danielloureno.substack.com";
  const envFile = flags["env"] || flags["e"] || null;
  const sidFlag = flags["sid"] || null;
  const wantJson = !!flags["json"];
  const dryRun = !!flags["dry-run"];
  const audience = flags["audience"] || "everyone";

  let markdown = "";
  let title = flags["title"] || null;
  let subtitle = flags["subtitle"] || null;

  if (file) {
    if (!fs.existsSync(file)) {
      console.error(`File not found: ${file}`);
      process.exit(1);
    }
    markdown = fs.readFileSync(file, "utf8");
    // auto-title from first # heading if not provided
    if (!title) {
      const m = markdown.match(/^#\s+(.+)$/m);
      if (m) title = m[1].trim();
      else title = path.basename(file, path.extname(file));
    }
  } else if (dryRun) {
    markdown = flags["markdown"] || "# Dry run\n\nHello from substack-cli.";
    title = title || "Dry run";
  }

  if (!markdown.trim()) {
    console.error("Markdown is empty");
    process.exit(1);
  }

  // For dry-run we still show conversion but skip SID
  if (dryRun) {
    const doc = mdToTiptap(markdown);
    const payload = {
      draft_title: title,
      draft_subtitle: subtitle || "",
      draft_body: JSON.stringify(doc),
      type: "newsletter",
      audience,
      draft_bylines: [],
    };
    if (wantJson) {
      console.log(JSON.stringify({ dryRun: true, pub, payload, tiptap: doc }, null, 2));
    } else {
      console.log(`[dry-run] pub=${pub} title="${title}"`);
      console.log(`Tiptap nodes: ${doc.content.length}, draft_body bytes: ${Buffer.byteLength(payload.draft_body, "utf8")}`);
      console.log(JSON.stringify(payload, null, 2).slice(0, 2000));
    }
    return;
  }

  // live: need SID
  let sid;
  try {
    sid = getSid({ envFile, token: sidFlag });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  try {
    const res = await createDraft({ sid, publicationUrl: pub, markdown, title, subtitle, audience });
    const url = `https://${pub.replace(/^https?:\/\//, "").replace(/\/+$/, "")}/publish/post/${res.id}`;
    if (wantJson) {
      console.log(JSON.stringify({ id: res.id, url, title, pub, raw: res.raw }, null, 2));
    } else {
      console.log(`✅ Draft created: id=${res.id}`);
      console.log(`   Title: ${title}`);
      console.log(`   URL:   ${url} (edit in Substack)`);
      console.log(`   Pub:   ${pub}`);
    }
  } catch (e) {
    console.error(`❌ drafts create failed: ${e.message}`);
    if (wantJson) console.log(JSON.stringify({ error: e.message }, null, 2));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
