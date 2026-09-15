# SubstackCLI — Agent Guide

## Purpose
CLI to **upload and manage** Substack drafts/published posts via internal API (`substack.sid` cookie). First command: `drafts create` (md → Tiptap `draft_body` stringified). Never publishes on create.

## Stack
ESM Node 18+ (native `fetch`). No deps. Mirrors `SubstackKit` style (`bin/cli.js` dispatcher, `lib/*.js`).

## Structure
| Path | Purpose |
|---|---|
| `bin/cli.js` | CLI dispatcher (`drafts create|list|get|update|delete|publish|schedule|unschedule|export|counts` + `published list`/`scheduled list`) — flags: `--pub`, `--title`, `--subtitle`, `--audience`, `--env`, `--sid`, `--json`, `--dry-run`, `--yes`, `--send/--no-send`, `--at`, `--output`, `--md-dir` |
| `lib/md.js` | `mdToTiptap(markdown, {imageMap})` + `parseInline` — Tiptap nodes: `heading`/`paragraph`/`bulletList`/`orderedList`/`blockquote`/`codeBlock`/`horizontalRule` + marks `strong`/`em`/`code`/`link`/`strike` + standalone `captionedImage` for `![alt](src "caption")` |
| `lib/auth.js` | `getSid` (loads `.env` + central `/mnt/HD/Junior/Projects/.substack.test.env` fallback) + `resolveBylines` via `GET /user/profile/self` |
| `lib/drafts.js` | `createDraft`/`updateDraft` (auto `uploadLocalImages` → `mdToTiptap` → `draft_bylines`), `getDraft`, `deleteDraft`, `listDrafts`/`listPublished`/`listScheduled`, `prepublishDraft`, `publishDraft`, `scheduleDraft`/`unscheduleDraft`, `getCounts` |
| `lib/images.js` | `uploadImage` (`POST {pub}/image` base64) → `captionedImage>image2` + `findLocalImages`/`buildCaptionedImage` (200ms gap) |
| `lib/frontmatter.js` | `parseFrontmatter`/`stringifyFrontmatter` — YAML `title/subtitle/audience/slug/tags` (CLI flags override) |
| `lib/convert.js` | `tiptapToMarkdown`/`draftToMarkdown` — reverse `draft_body` → md with frontmatter, `pullquote`→`:::pullquote`, `calloutBlock`, `captionedImage`→`![alt](src "caption")`, `footnoteAnchor`/`footnote`, `latex`→`$`, `codeBlock`, `horizontal_rule`, opaque `<!-- substack-cli-node:v1 ... -->` |
| `tests/md.test.mjs` | 8 offline unit tests (`node --test`) |

## Key Conventions (from SubstackAPI docs)
- Auth: `Cookie: substack.sid=` alone (`SubstackAPI/AUTH.md:5`). No CSRF.
- Two scopes: platform `substack.com/api/v1` vs pub `{pub}.substack.com/api/v1`.
- Draft payload requires `draft_bylines: [{id, publicationUserId}]` (`SubstackAPI/API_REFERENCE.md:582`). We fetch via `resolveBylines`; empty `[]` also works for TEST (verified live) but we send correct bylines.
- `draft_body` is **stringified** JSON (`API_REFERENCE.md:580`). Sending raw object renders as visible markup.
- Limit: ~976 KB `draft_body` (`SubstackAPI/LIMITS.md:30`).
- Tiptap marks `strong`/`em` vs ProseMirror notes `bold`/`italic` (`SubstackAPI/CONTENT_FORMATS.md:11`).
- Rate: 60 req/min global, 1 req/s safe (`LIMITS.md:8`). No Retry-After headers.

## Commands
```sh
# dry-run (no POST)
node bin/cli.js drafts create ./post.md --pub danielloureno.substack.com --dry-run --json

# live (TEST account — safe)
node bin/cli.js drafts create ./post.md --pub danielloureno.substack.com --env /mnt/HD/Junior/Projects/.substack.test.env --title "Hello" --json

# verify then cleanup
curl -s "https://danielloureno.substack.com/api/v1/drafts/<id>" -H "Cookie: substack.sid=$(grep SUBSTACK_SID /mnt/HD/Junior/Projects/.substack.test.env | cut -d= -f2-)"
curl -s -X DELETE "https://danielloureno.substack.com/api/v1/drafts/<id>" -H "Cookie: substack.sid=..."
```

## Credentials
Central store `/mnt/HD/Junior/Projects/.substack-credentials.env`:
- `SUBSTACK_SID_TEST` (id 250852026, pub 7073311 danielloureno) — **use for writes**
- `SUBSTACK_SID_MAIN` (id 399614913, danielloureno1) — **read-only**, publishing edits irreversible
Per-env: `/mnt/HD/Junior/Projects/.substack.test.env` (`SUBSTACK_SID=...`).

## Tested Live (2026-09-15)
- `drafts create` id `215859735` + `215859764` on `danielloureno.substack.com` (TEST) — verified `GET /drafts/{id}` returns `draft_title`, `draft_body` with correct Tiptap (heading, strong, em, code, link, bulletList, blockquote, codeBlock, hr), `postBylines` correct, then `DELETE` cleaned both (GET returns `Rascunho não encontrado`).
- `drafts list` / `drafts counts` / `published list` — `GET /post_management/drafts` shows 32 drafts, `counts` published 4/drafts 32, published list top [202745152,…]
- `drafts publish` id `215860457` `Publish Cycle Test` — `prepublish` {errors:[], suggestions:[MISSING_SUBSCRIBE_CTA]}, `POST /publish` {send:false} → slug `publish-cycle-test-substack-cli`, `is_published:true`, published list grew 4→5, `drafts get` shows slug, then `DELETE` cleaned (counts 5→4)
- `drafts update` id `215860524` — `PUT` title override + body `strong`/`bulletList` verified via `GET`
- `drafts schedule/unschedule` id `215860538` — `POST /scheduled_release` {trigger_at:2027-01-01T12:00:00Z} → `postSchedules:[12583875]`, `scheduled list` shows it, `GET /scheduled_release` verified, `DELETE /scheduled_release` → [12583875], list empty, then `DELETE` draft cleaned
- `image upload` id `215863463` local `local_test.png` → `POST {pub}/image` → `captionedImage>image2` `f398c74f_1x1.png` `width:1 height:1 bytes:70`, `draft_body` contains `captionedImage` with `Figure 1: Local image caption`, publish `image-upload-test-substack-cli` body_html has `<div class="captioned-image-container">` then `DELETE`
- `frontmatter` id `215863656` `--- title: FM Title Override / subtitle: FM Subtitle / audience: only_paid ---` + `![Alt](./local_test.png "Caption")` → `draft_title` FM Title, `draft_subtitle` FM Subtitle, `audience:only_paid` verified, uploaded `1c9f17c9_1x1.png` `1x1`
- `complex showcase` kept `215860998` `publish-cycle-test-substack-cli` — 42-node Tiptap (headings, bold/italic/bold+italic/code/strikethrough/sup/subscript/link, bullet_list/ordered_list/blockquote, pullquote `color:#FF5733`→`<div class="pullquote">`, calloutBlock→`<div class="callout-block">`, codeBlock, horizontal_rule, captionedImage, footnoteAnchor/footnote, youtube2, textStyle `RED/BLUE`) → `body_html` 8972 wc 188, `GET /drafts` + `GET /posts/by-id` verified, `drafts export` → `114 lines` md with `:::pullquote`/`:::callout`/`[^1]`/`![alt](src "caption")` + frontmatter, `--md-dir` writes `Articles/<slug>.md`
