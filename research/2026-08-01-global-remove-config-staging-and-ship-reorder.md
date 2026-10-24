# Remove config_v2 git-promotion staging, and ship `reorder` in released apps

## Context

**The bug.** `http://equin.ai` renders the landing sections in the order
`release-switcher → cta → hero → pillars` — alphabetical by plugin id, i.e. raw
registration order. The committed layout in `config/apps/website/shell/website.section.jsonc`
says `hero → pillars → release-switcher → cta`, and locally that is exactly what
renders. The deployed site ignores it.

**Why.** `https://equin.ai/api/config-v2/snapshot` returns **9** config descriptors
(sonata keyboard + 8 theme-token groups). On main there are ~180. None of the 121
per-slot reorder descriptors is registered, and grepping all 185 deployed JS chunks
finds no reorder barrel. `reorder` is simply **not in the website composition**.

It is absent because reorder registers middleware *into* `slot-render`, which never
imports it back — a **soft** edge. `resolveComposition` (`plugins/plugin-meta/plugins/closure/core/resolve-composition.ts:107`)
builds `bundle = hardClosure(entrySeeds ∪ selectedContributors)` with no fixpoint and
no auto-activation, so reorder lands in the `available` frontier and drops out. No
manifest lists it. `loadBearing: true` is **not consulted** by closure resolution.

Excluding reorder does not remove a feature — it silently re-renders every slot in
registration order and drops every authored `config/**/<slot>.jsonc` layout. This
affects *every* released composition, not just the website.

**Why the removal is a prerequisite.** Adding `reorder` to `served-baseline` was tried
and `./equin build` failed:

```
• composition-closure ... FAIL
  composition "sonata" excludes bundle "agent-runtime" but its closure
  includes 1 plugin(s) from it: infra.worktree
    reorder →(hard) config_v2.staging
    config_v2.staging →(hard) infra.worktree
```

`reorder/web` imports `config_v2/staging/web`. Closure membership is **per-plugin, not
per-runtime**, so that also ships `staging/server`, whose `land.ts:8` imports
`infra/worktree/server` — it lands staged defaults by spinning a throwaway git worktree
and running `./equin push`. `infra.worktree` is in the `agent-runtime` bundle,
which `sonata` and `website` declare in `excludes`.

Measured closure for the `website` manifest:

| | plugins |
|---|---|
| today (broken) | 115, `reorder` absent |
| + reorder, staging intact | 156 — adds `database`, `database.migrations`, `infra.jobs`, `infra.entities`, `config_v2.staging`, `infra.worktree` |
| + reorder, staging removed | **~121** |

34 of the 41 added plugins trace to the staging edge alone. Shipping it as-is would give
a public marketing site Postgres and a job queue.

**The feature being removed.** `config_v2` staging (`plugins/config_v2/CLAUDE.md` §"Promoting
a runtime edit to a git default"): a runtime user-layer config edit could be staged as a
proposed committed default, reviewed in the review pane with a before→after diff, then
landed on `main`. Owner: never used. `staged_config_default` on main: 0 rows. Historical
note — the table replaced an earlier `reorder_staged_default`; staging was generalized
*out of* reorder, which is why reorder is still welded to it.

**Outcome.** Released apps render their committed slot layouts. equin.ai shows
hero → pillars → release-switcher → cta.

## Decisions taken

- Removal + the `served-baseline` fix land as **one change** — `composition-closure` going
  from red to green is the proof the removal achieved its purpose.
- **Full** `promotableToGit` cleanup, including the now-unused `ConfigDetail.Action` slot.
- Studio's "Set as default for everyone" button is **accepted as lost**.

## Changes

### A. Delete outright

| path | what it owns |
|---|---|
| `plugins/config_v2/plugins/staging/` (incl. `plugins/promote-action/`) | ~1375 LOC: `staged_config_default` table, job `config-v2.land-defaults`, 5 routes under `/api/config-v2/staged-defaults`, push resource `config-v2-staged-defaults`, the `Staging.DiffRenderer` slot, and `git-layer-writer.ts` — the repo's **only** runtime writer to the committed `config/` tree |
| `plugins/review/plugins/config-defaults/` | ~336 LOC; sole contribution is `ReviewSlots.Section({id:"config-defaults"})`, which exists only to render staged rows |
| `plugins/plugin-meta/plugins/composition/web/internal/promote.ts` | `usePromoteManifestsToGit` |

### B. Edit

**reorder core** (`plugins/reorder/`)
- `web/internal/staged-tree.ts` — delete (the whole file is the staging adapter).
- `web/internal/dnd-list-middleware.tsx` — drop the `useStageDefault` import (:28);
  `effectiveItems = stagedTree ?? items` (:239) becomes `items`; `commitTree`'s
  `if (scope === "everyone") stageDefault(...)` branch (~:301-312) collapses to
  `setConfig("items", tree)`.
  > **Keep `commitTreeRef` and the `useCallback([])` handler shape.** They look vestigial
  > once the fork is gone, but they are load-bearing for an unrelated reason documented at
  > :618-624: the stable identities feed `ReorderEditor`'s `ctxValue` useMemo, and a fresh
  > identity "re-renders every draggable item app-wide on every live-state push". Inlining
  > `setConfig` into the handlers is a perf regression across every slot.
- `web/index.ts` — drop the `Staging` import and the `Staging.DiffRenderer` contribution;
  `contributions` becomes plain `reorderConfigContributions`. Also drop the now-unused
  `reorderDescriptorEntries` import (its only use was the DiffRenderer `match`). Drop the
  dead `diffReorderTrees` / `ReorderDiffEntry` / `ReorderTreesDiff` exports.
  `web/components/` is left empty — remove the dir.
- `web/components/reorder-diff-renderer.tsx`, `web/internal/diff.ts` — delete
  (confirm no external importer of `diffReorderTrees` survives first).
- `web/internal/scope-store.ts` — delete. `ReorderScope`'s `"everyone"` means "staged as a
  git default"; with no destination the whole personal/everyone concept dies.
- `web/internal/edit-mode-store.ts` — **survives, but must be edited**: drop the
  `setReorderScope` import (:2) and the `if (!value) setReorderScope("personal");` reset
  inside `setEditMode` (:13). This is the one non-obvious coupling — the edit-mode signal
  itself reaches into the scope store, so deleting `scope-store.ts` without this breaks
  a file that otherwise looks untouched.

*Verified:* the only readers of `useReorderScope`/`getReorderScope`/`setReorderScope`/`ReorderScope`
are the reorder barrel, `dnd-list-middleware.tsx:33,228`, `edit-mode-store.ts:2,13`, and
`edit-mode/scope-toggle.tsx` — all deleted or edited above, no external strand.
`diffReorderTrees`/`ReorderDiffEntry`/`ReorderTreesDiff` have **no importer outside** the
barrel and the two files being deleted.

**reorder/plugins/edit-mode**
- Delete `internal/{scope-toggle,exit-prompt-observer,exit-commit-popover,exit-prompt-store}.tsx`
  — every one is staged-defaults machinery.
- `internal/pen-button.tsx` — drop `useHasStagedDefaults`, the staged `StatusDot`, and the
  `ExitCommitPopover` wrapper; it becomes a plain edit-mode `IconButton`.
- `web/index.ts` — contributions collapse from 2 `ActionBar.Item`s + `Core.Root` + shortcut
  to **1 `ActionBar.Item` + the Esc shortcut**. Exiting edit mode becomes a plain toggle.

**config_v2 core + settings**
- `core/internal/types.ts:40`, `core/internal/define-config.ts:9,47` — remove `promotableToGit`.
- The `ConfigDetail.Action` slot dies across **four** settings files (verified: staging's
  `promote-action` is its only contributor repo-wide):
  - `plugins/settings/web/internal/detail-action-slot.ts` — delete (slot + `ConfigDetailActionContext`).
  - `plugins/settings/web/components/detail-actions.tsx` — delete (17 lines; renders the slot).
  - `plugins/settings/web/components/config-detail.tsx` — remove the `actionContext` assembly
    block (~:165-193, incl. the `promotableToGit` read at :179) **and the
    `<ConfigDetailActions {...actionContext} />` render site at :239**.
  - `plugins/settings/web/index.ts:8-9` — drop the `ConfigDetail` + `ConfigDetailActionContext` exports.
- Drop the now-pointless `promotableToGit: true` from its three producers:
  `reorder/shared/directive.ts:49`, `plugin-meta/composition/core/config.ts:32`,
  `primitives/data-view/plugins/view-core/shared/internal/views-descriptor.ts:57`.

**studio / composition**
- `apps/studio/compositions/web/components/compositions-list.tsx` — delete
  `PromoteDefaultButton` (:36-46) **and its render site (:91)**, plus the imports that
  become unused: `MdPublic`, `WithTooltip`, `usePromoteManifestsToGit`. The action row's
  `justify="between"` now has a single child — check it still reads right.
- `plugin-meta/composition/web/index.ts:15-16` — drop the `usePromoteManifestsToGit` export
  **and the `PromoteManifestsToGit` type export**.

**The fix itself**
- `plugin-meta/composition/core/config.ts` — add `"reorder"` to the `served-baseline`
  `subsystem(...)` entry list (becomes `reorder.**`, so the node-type renderers come too —
  a layout naming a spacer or header group needs them). Comment it with the same
  "force it in" rationale the `apps-core.layout` / `shell.toast` entries already carry.
- `plugin-meta/composition/core/config.test.ts` — add a `served-baseline forces the reorder
  layer` guard test mirroring the existing toast-host one.

### C. Committed config — THREE files, and a trap

> **Trap.** All three carry `requiresAuthoredOverride`. Deleting one does **not** make it go
> away — `./equin build` re-seeds it and stamps a `// @review` marker, which fails
> `config:overrides-authored`. That check is `alwaysRun: true`
> (`plugins/config_v2/check/overrides-authored.ts:70`), so `--skip-checks` will not dodge it.
> **Edit these in place and restamp `// @hash` against the regenerated origin.**

| file | change |
|---|---|
| `config/review/review.section.jsonc` (+ `.origin`) | drop `review.config-defaults:config-defaults`, leaving only `review.code-review:code-review` |
| `config/shell/action-bar/action-bar.item.jsonc` (+ `.origin`) | drop the trailing `"reorder.edit-mode:reorder-scope-toggle"` — the scope toggle is deleted, and a stale `entryKey` here fails `plugin-refs-resolve`. Keep `"reorder.edit-mode:reorder-pen"`. |
| `config/config_v2/settings/config-detail.action.{jsonc,origin.jsonc}` | **delete both** — the slot itself is gone, so it leaves the reorder manifest (`reorderable-slots-in-sync`). This is the one case where deletion is right, precisely because the descriptor stops existing. |

`config/plugin-meta/composition/compositions.origin.jsonc` is regenerated by build.

> If you instead chose to **keep** the `ConfigDetail.Action` slot, do not delete its config —
> edit it to `"items": []` and rewrite its comment (which currently explains why
> `promote-default` leads the strip). 22 config files already sit at `"items": []`, so that
> is a well-precedented end state.

### D. Docs (hand-written prose; AUTOGEN blocks regenerate themselves)

- `plugins/config_v2/CLAUDE.md` — delete §"Promoting a runtime edit to a git default"
  (:102-126). **Keep** the hash-chain / conflict / three-way-merge sections.
- `plugins/reorder/CLAUDE.md` — delete the "Personal vs everyone scope" paragraph and the
  `Staging.DiffRenderer` mentions.
- `plugins/plugin-meta/plugins/composition/CLAUDE.md` — drop the `promotableToGit`
  follow-up sentence.
- `plugin-meta/composition/core/config.ts:113-136` — **rewrite the website-composition
  comment** (see §E).
- `docs/plugins-compact.md`, `docs/plugins-details.md` — regenerated.

### E. Bonus: the editor-toy exclusion may become removable

`config.ts:113-136` documents the website composition's `!apps.website.demos.editor-toy.**`
negative, and names *this exact taproot* as the reason:

> "the block editor's hard closure now reaches worktree infra: `page.editor → reorder →
> config_v2.staging → infra.worktree` … A public site can't ship a live block editor without
> also shipping the worktree/git-landing infra behind it, so editor-toy is left out …
> **(Severing the reorder→staging→worktree taproot to make a live editor releasable
> stand-alone is a follow-up.)**"

This change *is* that follow-up. After the removal, try dropping the negative and let
`composition-closure` adjudicate — do not assume it passes. If it does, equin.ai gains the
live in-browser block editor demo, and the comment must be rewritten either way.

## Sequencing

One commit, but edit in this order so `tsc` stays a useful signal:

1. Consumers first — `review/config-defaults`, `promote.ts` + the Studio button, reorder's
   three staging call sites, edit-mode internals. Staging now has zero importers.
2. Delete `plugins/config_v2/plugins/staging/`.
3. `promotableToGit` + `ConfigDetail.Action` cleanup.
4. `served-baseline` entry + guard test.
5. `./equin build` — regenerates the `DROP TABLE` migration + snapshot + `_journal.json`,
   the registries, the docs, and prunes orphaned origins.
6. `git rm` the two non-origin config overrides; `git add -A`; review the diff.
7. `./equin check`.

**Precedent to mirror:** `f62e4534d` ("replace DB-backed groups with a contributed node-type
registry") deleted `plugins/reorder/plugins/groups/` — 2 tables, 4 endpoints, a resource —
and shows the exact diff shape. `git show --stat f62e4534d`.

## Checks to satisfy

| check | what it wants |
|---|---|
| `composition-closure` | **the proof** — red today, must go green |
| `migrations-in-sync` | commit the build-generated `DROP TABLE staged_config_default CASCADE` + snapshot + journal |
| `orphaned-db-tables` | the DROP must actually run against the DB, not just exist as a file |
| `plugin-refs-resolve` | no stale plugin path or `entryKey` anywhere — this is what catches §C if missed |
| `config-origins-in-sync` | orphaned origins pruned **and staged** |
| `plugins-registry-in-sync`, `plugins-doc-in-sync`, `reorderable-slots-in-sync`, `eager-tier-in-sync` | all self-heal on rebuild |
| `plugin-boundaries`, `type-check` | no dangling `@plugins/config_v2/plugins/staging/...` import |

Not applicable: `durable-signals-accounted` (staging declares no `defineLogSink`); growth
bounds are module-eval side effects, so nothing to unregister. No drizzle-kit rename prompt
is expected — this is drops-only, the repo has zero `*_answers.json` sidecars, and neither
prior table-drop commit needed one.

Cosmetic only: `plugins/framework/plugins/cli/bin/migrations.test.ts:67-91` uses the string
`"staged_config_default"` as a prompt-key fixture. It tests derivation, not the real table,
so it keeps passing; rename if you want tidiness.

## Verification

1. `./equin build` and `./equin check` both green.
2. **Closure assertion** — a read-only script: `buildPluginTree(root + "/plugins", { skipBarrelImport: true, facets: true })`
   → `classifyEdges` → `flattenManifest` → `resolveComposition` on the `website` manifest.
   Assert the bundle **contains** `reorder` and **lacks** `config_v2.staging`, `infra.worktree`,
   `database`, `infra.jobs`; assert size ≈ 121 (from 115).
   > **Hazard:** do *not* verify with `./equin build-composition`. It writes
   > `server.composition.generated.ts` into this worktree, which `plugins-active.ts`
   > then selects **over** `server.generated.ts` — changing which registry this worktree's
   > own backend boots. Use the read-only script.
3. **Local UI** — deploy, open `http://<worktree>.localhost:9000/website`: order is
   hero → pillars → release-switcher → cta. Pen button still toggles edit mode; a drag still
   persists to the user layer; no scope toggle, no exit popover, no status dot.
4. Review pane shows only "Code review". Settings → any reorder slot config shows no
   "Set as default for everyone" action.
5. `bun test plugins/plugin-meta/plugins/composition/core/config.test.ts`
6. `query_db`: `select to_regclass('staged_config_default')` → `null`.
7. **The actual bug** — after merge, re-run the release + deploy for the `website`
   composition, then:
   - `curl -s https://equin.ai/api/config-v2/snapshot` → descriptor count jumps from 9 and
     includes `apps/website/shell/website.section.jsonc`
   - rendered `h1/h2` order is hero → pillars → release-switcher → cta

## Other user-visible effects

- Pen button loses its `Inline gap="none" relative` wrapper (it existed only to anchor the
  exit popover) → a bare button; minor action-bar layout nudge.
- Config detail pane's toolbar loses its actions strip entirely.
- Studio compositions action row drops to a single child.
- `setEditMode(false)` stops mutating a second store — edit mode becomes a pure signal.
- Retires one app-wide `Core.Root` host and its per-session live-state subscription, a
  graphile job, 5 routes, and the `config-v2-staged-defaults` resource — which is one of the
  legacy unbounded collection resources on the bounded-working-set migration list.

**`edit-mode` stays its own plugin.** Down to 1 `ActionBar.Item` + 1 shortcut + a ~12-line
pen button, it is tempting to fold back into `reorder` — don't. Its CLAUDE.md records the
reason: `shell/slots.ts` wraps its slots with the reorder middleware, so reorder contributing
to shell's slots would form a cycle. Unaffected by this change.

No test or e2e script exercises the staging feature.

## Accepted capability loss

- No runtime path to promote a config edit to a committed default. Changing a default means
  editing `config/**/<name>.jsonc` in a worktree and `./equin push` — the normal agent
  workflow, and how `served-baseline` is changed in this very plan.
- Studio composition manifests stay user-layer; the code defaults in
  `plugin-meta/composition/core/config.ts` are the sole source of truth.
- reorder drags write only the personal user layer.
- `DROP TABLE` destroys any staged rows. Main has 0; other worktree forks may differ.
  **Irreversible.**
- User-layer files under `~/.singularity/config/<wt>/` for deleted descriptors are never
  auto-pruned, only classified (Debug → Config Orphans). Harmless.

## Follow-ups (explicitly out of scope)

- **`seedReleaseConfig` is copy-if-absent** (`plugins/infra/plugins/launcher/server/internal/boot.ts:903`):
  `if (existsSync(dest)) return;`. The bundle ships fresh defaults every release, but the
  host's persistent data dir means they are unpacked on the **first run only** — later ships
  never refresh them. Needs `propagate()` per descriptor instead of a directory copy;
  complicated by the launcher deliberately not being able to import `config_v2` (`boot.ts:891`
  — DOM-free `tools` tsconfig). Likely not blocking this fix, since `propagateConfigToUser`
  walks the whole `config/` tree, so the first ship's seed probably already carries the
  website origins — unconfirmed without SSH to the host.
- Released apps still ship reorder's DnD machinery (`reorder.editor`, `primitives.sortable-list`,
  dnd-kit) because `dnd-list-middleware` both applies the layout and hosts the drag surface.
  Splitting "apply" from "edit" would cut ~4 more plugins and drop dnd-kit from released
  bundles.
