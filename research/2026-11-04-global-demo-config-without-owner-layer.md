# The browser demo gets a fresh install's config, not the owner's

Track: "apps running in the browser, on fake or local data" (wiki
`block-d04c6c0d-56fd-49f2-88f4-914e059cc83b`), lane B step 1. Prior designs:
`2026-10-16-global-config-git-layer-per-composition.md`,
`2026-10-21-global-demo-config-from-worker.md`.

## Context

The demo's worker bundles the repo's whole `config/` (`config_v2/plugins/bundled-layer`,
`import.meta.glob("/config/**/*.jsonc")`) and seeds its memory store from it. Some of that
layer is the owner's own content: their prompt templates, preprompts, conversation
categories. The demo is going public, so that cannot ship. User's decision: the demo gets
what a fresh local install gets — the defaults, nothing owner-specific — and visitor edits
still go through the real handlers.

## What a fresh install's config is, in this repo

There are three layers (`config_v2/CLAUDE.md`):

1. **Code defaults** — `defineConfig` → `config/**/<name>.origin.jsonc` (467 files).
2. **The committed overrides** — `config/**/<name>.jsonc` and `@app/<id>/` deltas (265 files).
3. **The user layer** — `~/.equin/state/config/<namespace>/`, never in git.

A fresh install gets 1 + 2. Release vendors `config/` (`release/cli/run.ts`), the
git-defaults preview calls the committed layer "what a brand-new user sees", and layer 2
mostly *is* product design, which the build requires:

| Committed overrides | Files | What they are |
| --- | --- | --- |
| reorder directives (`items`) | 144 | required authored layout (`requiresAuthoredOverride`, `reorder:configs-authored`) |
| DataView views (`views`, presets, columns) | 94 | required authored views (`viewsDescriptor`) |
| per-app themes, sidebar/tab variants | 20 | each app's look |
| `tasks/task-draft-form/@app/agent-manager` | 1 | a product call, with its reason in a comment |
| **manual values seeded from the owner's legacy DB** | **6** | **the owner's** |

The six are `conversations/preprompts`, `conversations/conversation-view/prompt-templates`,
`conversations/conversation-category`, `conversations/conversation-view/turn-summary`
(`enabled: false`), `review/code-review` (safe/careful paths) and `stats/commits` (excluded
paths). They came in with `7680aaefa0` ("seed v2 config overrides from legacy DB values")
and `b4d87e3e85`. They were moved from the owner's DB into git at the config v2 migration,
so they are the user layer stored in the wrong tier. The owner's main user layer already
overrides the first three again.

So **a fresh install's config = code defaults + the shipping overrides**. Today `config/`
mixes the shipping overrides with the owner's six, and nothing tells them apart. That is the
bug, and it reaches every fresh clone and release as well as the demo.

## Design: the owner's layer is its own committed root

- **`owner-config/`** (new, repo root) holds the owner's committed values, in the same layout
  as `config/`. It holds **override files only**: an `.origin.jsonc` there is an error,
  because the origin is always `config/`'s. Each file's `// @hash` is anchored to the
  `config/` origin, exactly like a shipping override.
- **The checkout's committed layer = `config/` with `owner-config/` on top.** For an override
  file, the owner's file wins over the shipping one. Origins come from `config/` only. App
  ids are the union of both roots. This rule is spelled once in `config_v2/core`
  (`withOwnerLayer(shipping, owner)`), next to `committedDocument`.
- **Who reads which:**
  - Desktop runtime (`config_v2/machine` `repoConfigLayer`) and build propagation
    (`propagateConfigToUser`): the checkout layer, owner included. The owner's machine
    resolves the same documents as before, so the propagated origins keep their hashes and
    no user override goes into conflict.
  - Browser hosts (`bundled-layer`): `config/` only. The glob names `/config/` and the
    owner's root is a different directory, so the demo can never bundle it.
  - Release staging: `propagateConfigToUser` takes a required `ownerLayer: boolean`
    (tsc makes every caller choose). `release` passes `false`, since a release ships to
    other people; `build` and the composition reset pass `true`.
- **One fs reader.** The three copies of a CommittedFiles-over-a-directory (machine
  `repo-layer.ts`, relocate `apply-moves.ts`, and now codegen) become one core
  `committedFilesIn(dir, fs)`. The fs functions are passed in, so core stays platform-free.
  `propagateConfigToUser` resolves through `committedDocument` instead of its own copy of
  the resolution.
- **Checks.** `config-origins-in-sync` also covers `owner-config/`: each file must be an
  override, its `@hash` must match the `config/` origin, it must validate against the
  schema, and a file with no live origin is an orphan (failure). The build never deletes
  owner files: they are hand-written, so a stranded one is reported, not pruned.
- **Plugin move.** `./equin plugin move` also `git mv`s `owner-config/<from>` when it exists.
- **Move the six files** `config/<p>.jsonc` → `owner-config/<p>.jsonc`, byte-identical.

Not in scope (file as follow-ups): a stranger's clone still reads `owner-config/`, because it
is committed. Gating it on "this checkout owns the canonical repo" (the `upstream` /
`remotes` probe) is a separate decision. The two compositions-config readers
(`readGitLayerConfig`, `readEffectiveConfigFromDisk`) stay shipping-only. They read a
product setting the owner layer has no business overriding.

## Files

- `config_v2/core/internal/git-layer.ts`: `withOwnerLayer`, `committedFilesIn`,
  `SHIPPING_CONFIG_DIR` / `OWNER_CONFIG_DIR`. Tests in `git-layer.test.ts`.
- `config_v2/machine/internal/repo-layer.ts`: checkout layer; watch both roots.
- `codegen/core/config-origin-gen.ts`: `propagateConfigToUser` over `committedDocument`,
  `ownerLayer` option. Callers: `build/.../deploy-namespace.ts`, `release/cli/run.ts`,
  `build/plugins/serve-composition/server/internal/reset.ts`.
- `relocate/core/internal/apply-moves.ts` (shared reader), `relocate/cli` (git mv of the owner dir).
- `checks/plugins/config-origins-in-sync/check/index.ts`.
- `owner-config/CLAUDE.md` (new), `config/CLAUDE.md`, `config_v2/CLAUDE.md`.
- `bundled-layer/.../committed-config.test.ts`: the shipping layer holds none of the owner's
  values.
- The six config files moved.

## Verification

- `./equin test plugins/config_v2 plugins/plugin-meta/plugins/relocate plugins/framework/plugins/tooling/plugins/codegen`
  plus the lumen `browser-host.test.ts`.
- `./equin build` is green. Main's propagated origins for the six paths keep their hashes:
  diff this worktree's user-layer origins against main's.
- `/demo` on this build: the prompt templates and preprompts show the code defaults (empty),
  and a write still goes through the real handler.
- The demo e2e scripts (no-leak, app-switch, prototypes-in-demo) and the lumen boot test.
- Leak check: no string value of any `owner-config/` file appears in the built demo worker
  bundle.
