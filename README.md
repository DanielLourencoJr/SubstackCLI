# SubstackCLI

Upload and manage Substack drafts / published posts via the internal API (`substack.sid`).

> Uses undocumented `https://{pub}.substack.com/api/v1/drafts` (Tiptap JSON). May break anytime. No official affiliation.

## Quick start

```bash
# 1. auth — put TEST SID in .env (safe) or point to central file
echo "SUBSTACK_SID=s:..." > .env
# or: ln -s /mnt/HD/Junior/Projects/.substack.test.env .env

# 2. drafts create (creates unpublished draft, never publishes)
node bin/cli.js drafts create ./post.md --title "Hello" --pub danielloureno.substack.com --env .env

# dry-run: show payload without POST
node bin/cli.js drafts create ./post.md --dry-run --json
```

## Commands

- `drafts create <file.md>` — md → Tiptap `draft_body` (stringified) + `draft_bylines`, POST `{pub}/drafts`
- (next) `drafts list|get|update|delete|publish|schedule`

## Auth

Single cookie `substack.sid` from `DevTools → Application → Cookies` (SubstackAPI/AUTH.md).
Central store: `/mnt/HD/Junior/Projects/.substack-credentials.env` (`SUBSTACK_SID_TEST` safe, `_MAIN` read-only).

## Rate limits

~60 req/min global, 1 req/s safe. See `../SubstackAPI/LIMITS.md`.
