# SubstackCLI

Upload and manage Substack drafts / published posts via the internal API (`substack.sid`).

> Uses undocumented `https://{pub}.substack.com/api/v1/drafts` (Tiptap JSON). May break anytime. No official affiliation.

## Quick start

```bash
# 1. auth — use TEST SID (safe) or point to central file
echo "SUBSTACK_SID=s:..." > .env
# or: ln -s /mnt/HD/Junior/Projects/.substack.test.env .env

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
drafts delete <id> [--pub host] [--yes] [--json]
drafts publish <id> [--send|--no-send] [--yes] [--pub host] [--json]   # --no-send is silent (default)
drafts schedule <id> --at 2027-01-01T12:00:00Z [--pub host]
drafts unschedule <id> [--pub host]
drafts counts [--pub host] [--json]
published list [--limit 20] [--offset 0] [--pub host] [--json]
scheduled list [--limit 20] [--pub host] [--json]
```

Safety: `create` never publishes. `publish` requires `--yes`; default `--no-send` (silent). `send` emails irreversibly.

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
