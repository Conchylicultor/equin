# Rename the GitHub repo to `equin` (track step 8)

Track: the wiki page of the rename to equin (block-dc049371-1f5f-413d-af7b-6e12b531d579).

## Context

On 2026-10-27 the user decided the GitHub repo `Conchylicultor/singularity` is renamed to
`Conchylicultor/equin`, reversing the earlier "kept for good" (research/2026-10-25-global-equin-internal-identifiers.md).
After the step, no tracked file outside `research/` spells the old repo URL,
`LEGACY_IDS.githubRepo` is gone, `product-name:legacy-id` no longer allows repository URLs,
and the remotes point at the new URL.

GitHub redirects the old name's web links, `raw.githubusercontent.com` and git operations
only while no repo is ever created again under the old name.

## Inventory (checked 2026-10-28)

The repo has not been renamed yet: `Conchylicultor/equin` does not resolve.

| Where | What |
|---|---|
| `product-name/core/internal/legacy-ids.ts` | `githubRepo` + its note |
| `product-name/check/legacy-id.ts` | the `ALLOWED` repository-URL pattern (+ its test, the CLAUDE.md sentence) |
| `infra/git/remotes/core/internal/upstream.ts` | `CANONICAL_REPO_URL` literal (barrel export; no importer outside remotes) |
| `apps/website/shell/core/site.ts` | `SOURCE_URL`, `INSTALL_COMMAND` derived from `LEGACY_IDS.githubRepo` (download page, footer, GitHub link, Improve panel) |
| `install.sh` (usage comment + `REPO_URL`), `docs/setup.md`, `CITATION.cff` | literal URLs |
| `sidequests/clean-install/steps.sh`, `steps-install.sh` | literal URLs |
| tests: `remote-url.test.ts`, `cache.test.ts`, `classify.test.ts`, `upstream/shared/merge-prompt.test.ts` | URL fixtures |
| the shared `.git/config` | `origin` = `https://github.com/Conchylicultor/singularity.git`; cache keys `singularity.publish.{remote,url}` |

Not affected: the README (no URL); no GitHub Pages (`has_pages: false`); no `.github/` workflows,
so no actions used from other repos; the website deploy does not clone from GitHub. The
`singularity.*` git config section and the default checkout dir `~/singularity` are separate
kept ids (`gitConfigSection`, `defaultCheckoutDir`) and stay.

## Design

**One owner of the repo identity.** Today two code owners spell it
(`LEGACY_IDS.githubRepo` for the website, `CANONICAL_REPO_URL` for remotes). It is not a legacy
id anymore, so it moves out of `LEGACY_IDS` into the product-name leaf (where the product's
own name already lives, importable from browser, server and scripts):

```ts
// product-name/core/internal/source-repo.ts
/** The GitHub repository the product is published from (`owner/name`). */
export const SOURCE_REPO = "Conchylicultor/equin";
export const SOURCE_REPO_URL = `https://github.com/${SOURCE_REPO}`;
```

- `remotes`: `CANONICAL_REPO_URL` is deleted; `upstream.ts`/`cache.ts` comments and code use
  `SOURCE_REPO_URL`. Barrel export removed (no external importer), remotes CLAUDE.md updated.
- `website/shell/core/site.ts`: `REPO = SOURCE_REPO`; `SOURCE_URL = SOURCE_REPO_URL`.
- Files that cannot import it (install.sh, steps*.sh, setup.md, CITATION.cff) spell
  `Conchylicultor/equin`. Once the allowance is gone, an old URL in any of them fails
  `product-name:legacy-id` — that is the guard against the old spelling coming back.
- `legacy-ids.ts`: delete `githubRepo` and its note. `legacy-id.ts`: delete `ALLOWED`
  (and its use in `offendingLine` and in the hint); drop the "leaves repo URLs alone" test,
  add one asserting a repo URL with the old name is now an offence. CLAUDE.md sentence removed.
- Test fixtures move to the new URL (`classify.test.ts` uses `SOURCE_REPO`).

**Ordering (why the rename comes first).** `resolveUpstreamRemote` (daily upstream job, main
only) treats a checkout that can publish to something other than the canonical URL as a fork
and adds an `upstream` remote. If code saying `equin` landed on main while `origin` still said
`singularity`, main would be classified as a fork of itself. And the new `install.sh` URL
404s until the rename. So:

1. Build this branch (code ready, nothing outward yet).
2. **The user renames the repo on GitHub** (Settings → Repository name → `equin`).
3. Verify redirects: `curl -sI https://raw.githubusercontent.com/Conchylicultor/singularity/main/install.sh`
   and `git ls-remote https://github.com/Conchylicultor/singularity.git HEAD`; and the new
   URLs answer.
4. `git remote set-url origin https://github.com/Conchylicultor/equin.git` (worktrees share
   the main checkout's config, so one call covers every checkout here). The publish cache
   compares the URL by exact text, so it re-probes write access on its own — nothing to clear.
5. User pushes (`./equin push`) when they have reviewed.

No backward recognition of the old URL in code (it would keep the old name alive in the tree,
the opposite of the goal); clones by other people keep working through GitHub's redirect.

**Lint rule docs URLs (found while building, user decision 2026-10-28).** Removing the
allowance surfaced 156 lint rules whose `ESLintUtils.RuleCreator` wrote the docs URL
`https://github.com/anthropics/<old name>/lint/<rule>` (a repository that never existed;
sidequest task-1792907780-o47p62), plus 2 with `https://internal/…`. All 158 now use one
creator, `lintRuleCreator(import.meta.url)` in `tooling/lint/core` (`rule-creator.ts`): the
docs URL is the rule's own file on `SOURCE_REPO_URL` (`…/blob/main/<path>`), derived from
the module URL relative to the repo root (URL string ops, no `node:` import, since it is
`core/`), and `meta.docs` is typed `LintRuleDocs` for every rule.
`rule-kind-safety/no-raw-rule-creator` flags any `.RuleCreator` member; `rule-creator.ts`
itself is a sanctioned exemption in `tooling/lint/exempt`.

## Verification

- `./equin check product-name:legacy-id product-name:legacy-ids-in-sync type-check`
- `./equin test plugins/infra/plugins/git/plugins/remotes plugins/framework/plugins/product-name plugins/upstream`
- `rg -i 'Conchylicultor/singularity' -g '!research/**'` → nothing.
- `./equin build`, then the website download page shows the `Conchylicultor/equin` install command.
- After the rename: steps 3–4 above, `git fetch origin`.

## Track page

Mark the step-8 checklist; status says the repo is `equin`, with "never create a repo under
the old name" as the standing rule. Then the track's exit criteria are met (the remaining
human items are the user's own: `./equin start --force`, the cache-dir note) — tell the user
the track is complete rather than filing a next task, unless they want one.
