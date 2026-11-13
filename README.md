# SubstackCLI — merged into SubstackKit

> **This repository is archived.** Its functionality (drafts, publish,
> schedule, translate, folder sync, image/gallery upload, mentions) was
> merged into **[SubstackKit](https://github.com/DanielLourencoJr/SubstackKit)**
> as the write side of the unified `substack` CLI.

## Where things went

| This repo | In SubstackKit |
| --- | --- |
| `bin/cli.js` | `commands/write.js` (+ namespace dispatch in `bin/substack.js`) |
| `lib/convert.js` | `lib/tiptap_convert.js` (renamed to avoid `lib/convert/`) |
| `lib/{auth,drafts,files,frontmatter,images,md,sync}.js` | same names in `lib/` |
| `tests/md.test.mjs` | `tests/md.test.mjs` |
| `substack-cli ...` | still works: `bin/cli.js` compat shim → write side |

## Use instead

```bash
# install (deps, ~/.local/bin links, credentials, agent skill)
git clone https://github.com/DanielLourencoJr/SubstackKit.git
cd SubstackKit && ./install.sh

substack drafts create ./post.md --dry-run --json
substack drafts list --json
substack sync --dir ./Articles --dry-run
```

Safety rules are unchanged: `create` never publishes, `publish` requires
`--yes`, `--send` emails subscribers irreversibly (default `--no-send`),
writes default to the TEST account. See SubstackKit's README and
`skill/SKILL.md`.
