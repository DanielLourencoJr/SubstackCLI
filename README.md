# SubstackCLI

Upload and manage Substack drafts / published posts via the internal API (`substack.sid`).

> Uses undocumented `https://{pub}.substack.com/api/v1/drafts` (Tiptap JSON). May break anytime. No official affiliation.

## Quick start

```bash
# 1. local config — copy the example and fill in a SID privately
cp .env.example .env
# .env is ignored by Git; don't commit real credentials
# SUBSTACK_SYNC_DIR can be changed per device if the mount path differs

# 2. drafts create (creates unpublished draft, never publishes)
node bin/cli.js drafts create ./post.md --pub danielloureno.substack.com --title "Hello" --json

# dry-run: show payload without POST
node bin/cli.js drafts create ./post.md --dry-run --json
```

## Commands

```
drafts create <file.md> [--title t] [--subtitle s] [--pub host] [--audience everyone|only_paid] [--dry-run] [--json]
drafts list [--limit 20] [--offset 0] [--pub host] [--json]
drafts get <id> [--pub host] [--json]
drafts update <id> <file.md> [--title t] [--subtitle s] [--pub host]
drafts translate <id> <language> <file.md> [--title t] [--subtitle s] [--pub host]
drafts delete <id> [--pub host] [--yes] [--json]
drafts publish <id> [--send|--no-send] [--yes] [--pub host] [--json]   # --no-send is silent (default)
drafts schedule <id> --at 2027-01-01T12:00:00Z [--pub host]
drafts unschedule <id> [--pub host]
drafts export <id> [--output file.md] [--md-dir dir] [--pub host] [--json]
sync [--dir <path>] [--pub host] [--dry-run] [--yes] [--republish] [--no-pull] [--no-push] [--json]
drafts counts [--pub host] [--json]
published list [--limit 20] [--offset 0] [--pub host] [--json]
scheduled list [--limit 20] [--pub host] [--json]
```

Frontmatter in `post.md` overrides flags:

```yaml
---
title: FM Title
subtitle: FM Subtitle
audience: only_paid
tags: [a, b]
---
# Body...
![Alt](./local.png "Caption")  # local paths auto-upload to captionedImage
```

Custom language editions can be added to an unpublished draft with `drafts translate`. The publication must have **Additional post languages** enabled. Supply the translated title and body in Markdown; existing image URLs can be reused:

```bash
node bin/cli.js drafts translate 123456789 en ./post.en.md --pub danielloureno.substack.com
node bin/cli.js drafts translate 123456789 ja ./post.ja.md --pub danielloureno.substack.com
```

The command detects the draft's source language, creates the language edition if needed, and updates only that edition. Supported language codes include `en`, `ja`, `pt-br`, `pt-pt`, `en-gb`, and the other languages offered by Substack.

Folder sync uses this precedence: `--dir <path>`, `SUBSTACK_SYNC_DIR`, then `./Articles`. Set `SUBSTACK_SYNC_DIR=/mnt/HD/Junior/42/Substack/Archive/Sync` in your shell environment or local `.env` to use the same canonical folder without baking that machine-specific path into the CLI. An explicit `--dir` still takes precedence.

Sync stores each post under its status and edition:

```text
Drafts/
  Originals/<slug>.md
  Translations/<language>/<slug>.md
Published/
  Originals/<slug>.md
  Translations/<language>/<slug>.md
```

Translation files keep the same Substack post `id` and include `edition: translation` plus their language code in frontmatter. Originals use `edition: original`. Pulls include custom language editions attached to each post. Use `--no-push` for a read-only Substack sync that only organizes local files and downloads remote changes.

Safety: `create` never publishes. `publish` requires `--yes`; default `--no-send` (silent). `send` emails irreversibly.

### Publish for review, then email

To review the public page before notifying subscribers, publish the draft silently, open the returned URL, and send it later using the same post ID:

```bash
# Make the post public without emailing subscribers
node bin/cli.js drafts publish 123456789 --no-send --yes --pub danielloureno.substack.com

# Review the public URL printed by the command, then send the existing post
node bin/cli.js drafts publish 123456789 --send --yes --pub danielloureno.substack.com
```

The second command acts on the already-published post; it does not create another post. `--send` requests the subscriber email, and `--yes` confirms the irreversible action. If no review period is needed, use `--send --yes` on the draft to publish and email it in one step. For translated posts, readers are shown the custom edition matching their device language when available.

## Examples

```bash
node bin/cli.js drafts list --pub danielloureno.substack.com --env /mnt/HD/Junior/Projects/.substack.test.env --json
node bin/cli.js drafts get 215860457 --pub danielloureno.substack.com --json
node bin/cli.js drafts publish 215860457 --no-send --yes --json
node bin/cli.js drafts schedule 215860538 --at 2027-01-01T12:00:00Z
node bin/cli.js published list --limit 5 --json
```

## Auth

Single cookie `substack.sid` from `DevTools → Application → Cookies` (SubstackAPI/AUTH.md).
Central store: `/mnt/HD/Junior/Projects/.substack-credentials.env` (`SUBSTACK_SID_TEST` safe, `_MAIN` read-only).

## Rate limits

~60 req/min global, 1 req/s safe. See `../SubstackAPI/LIMITS.md`.
