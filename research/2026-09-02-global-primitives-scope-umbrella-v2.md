# Grouping the flat primitives/infra lists: wave 1 — five umbrellas

**Date:** 2026-09-02
**Category:** global
**Status:** Plan — awaiting approval
**Supersedes:** [`2026-09-02-global-primitives-scope-umbrella.md`](./2026-09-02-global-primitives-scope-umbrella.md)
(v1 planned `primitives/scope/` alone; its per-move mechanics section is still the
authoritative detail and is referenced rather than repeated here)

## Context

`plugins/primitives/plugins/` holds **95** entries and `plugins/infra/plugins/` holds **37**,
both flat. The root CLAUDE.md asks that `plugins/` read as semantic categories; at this size
neither umbrella does, and finding out whether a primitive for some concept already exists
means scanning a 95-line list. That is how the same idiom ends up hand-rolled three times.

The no-new-top-level-entry rule already sits atop both CLAUDE.mds. It stops the list
growing; it does not group what is there.

v1 planned one umbrella. The question then asked was whether all ten groupings from the
2026-09-01 sketch could land in a single session. They measure at **64 plugins, ~1,320
importer references** — and the answer is that the find-and-replace is trivial at any size,
but four failure classes are not, and they are unevenly distributed. So this plan takes the
**five umbrellas that carry none of them**, and defers the four that do to their own tasks.

### The split is empirical, not a guess

The deciding evidence: across every worktree's unversioned user config
(`~/.singularity/state/config/*/`), the complete set of real user overrides under
`primitives/` and `infra/` is

```
142 primitives/data-view/view-state.jsonc
140 primitives/data-view/prototypes.gallery.jsonc
140 primitives/data-view/config_v2.settings.nav.jsonc
 70 primitives/prompt-editor/prompt-editor.floating-action.jsonc
```

Nothing else. That is the user's saved DataView state (sort, filter, groupBy per view),
the prototypes gallery layout, the settings nav order, and one saved reorder layout. This
layer is **never auto-migrated** — the orphan audit only detects — so moving `data-view` or
`prompt-editor` silently reverts all of it to defaults until a rename script exists.

Both live in the deferred wave. Every plugin in wave 1 has **only generated `.origin.jsonc`
files**, which `pruneOrphanedConfigFiles` deletes at the old hierarchy and build regenerates
at the new one. Verified for `duress` specifically, whose `config/infra/duress/` holds
exactly one `.origin` file — which is what makes `infra/host/` safe.

## Wave 1 — the five umbrellas

Order is deliberate: smallest and already-decided first, so the pipeline is proven before
the wider moves ride on it.

| # | Umbrella | Members | refs | deep paths |
|---|---|---|---|---|
| 1 | `primitives/scope/` | `scoped-store` · `dom-scope` · `surface-id` · `tab-id` · `app-instance` · `install-sink` | 49 | 1 |
| 2 | `infra/git/` | `git-watcher` · `git-read-cache` | 17 | 0 |
| 3 | `infra/host/` | `host-admission` · `host-read-pool` · `contention` · `duress` | 60 | 1 |
| 4 | `primitives/dom/` | `dom-selection` · `element-size` · `in-view` · `auto-scroll` · `overscroll-hint` · `scroll-reveal` · `copy-source-text` | 61 | 4 |
| 5 | `primitives/overlay/` | `popover` · `imperative-dialog` · `cursor-menu` · `floating-surface` · `floating-action` · `surface-overlay` · `overlay-boundary` · `tooltip` · `popup-open` | 91 | 0 |

**Totals:** 28 plugins move (plus 3 sub-plugins carried along: `dom-scope`,
`duress/latch`, `imperative-dialog/confirm`), ~278 importer references.
**primitives 95 → 78, infra 37 → 33.**

Every member is verified to have: no committed `config/` dir beyond generated `.origin`
files, no `defineRenderSlot`/`defineMountSlot` declaration, no entry in `boundary-config.ts`
or in any check's hardcoded allowlist, and no non-empty `contributions` that would leave a
stale `"<pluginId>:<id>"` key in a saved reorder layout.

### Membership notes

- **`scope/`** — the two decisions from v1 stand: `install-sink` is **in** (it is the
  deliberate opposite lifetime, and the reader choosing between them should find both in one
  place), and `dom-scope` is **promoted to a sibling** of `scoped-store` rather than staying
  nested under it, since the umbrella removes the reason for that stopgap.
- **`dom/`** — the one arguable call in this wave. `auto-scroll`, `scroll-reveal` and
  `overscroll-hint` could form a `scroll/` group of their own. Keep them in `dom/`: all seven
  members are "read or drive the real DOM", and splitting seven into four-plus-three
  recreates the flat-list problem one level down.
- **`overlay/`** — `overlay-boundary` deliberately sits *below* `ui-kit` to avoid a cycle.
  An umbrella is a pure folder with no barrel, so it introduces no import edge and the
  layering is unchanged by construction. Same reasoning covers every other member.
- **`host/`** — `duress` joins despite owning a config descriptor, because that config has
  no user override anywhere (checked, not assumed) and its committed dir is one generated
  file that build re-derives.

## Mechanics

Identical for all five, and identical to what v1 spells out in full. Per wave:

1. `mkdir -p plugins/<um>/plugins/<name>/plugins`, then `git mv` each member in.
   Move a **nested** member before its parent (`dom-scope` out of `scoped-store`).
2. Write the umbrella's `package.json` and `CLAUDE.md`, mirroring
   `plugins/primitives/plugins/outline/` exactly — a pure umbrella is
   `{name, description, private, version}` plus a CLAUDE.md whose hand-written intro sits
   above the `<!-- AUTOGENERATED:BEGIN -->` markers. The `description` is what docgen renders
   as the umbrella's line in `plugins-compact.md`, so write it as the category question the
   umbrella answers, not as a list of its members.
3. Apply the substitution table for that wave, **longest prefix first**, over
   `**/*.{ts,tsx}`, skipping `*.generated.ts` and leaving `research/*.md` alone (those are
   dated records, not live references). Rewrite the **bare** form
   `plugins/<um>/plugins/<name>/` → `plugins/<um>/plugins/<group>/plugins/<name>/`, which
   catches both `@plugins/…` specifiers and plain path literals in one pass.
4. Fix the deep paths by hand (below).
5. `./equin build` — **`run_in_background: true`, then end the turn.** Confirm
   `status: ok` in `~/.singularity/worktrees/<wt>/build-status.json`; never infer a deploy
   from a log file's mtime.
6. `./equin check` to green, then checkpoint as one commit before starting the next
   wave.

**The one hazard in the scripted pass is rule order.** `dom-scope`'s current path is inside
`scoped-store`'s; rewrite the parent first and the child silently becomes
`…/scope/plugins/scoped-store/plugins/dom-scope/`. Longest prefix first, always, and grep for
that exact string afterwards.

**The six deep paths.** These are `../../..` links that escape their own plugin, so renaming
the plugin does not fix them — the *number* of `../` segments changes. A sed cannot see this;
each must be walked. This is the class that shipped broken last time (`ea280bee0`, a Tailwind
`@source` glob that silently narrowed 21 minutes after the relocation it followed).

| Wave | File |
|---|---|
| 1 | `install-sink/CLAUDE.md:114` → research link |
| 3 | `host-admission/CLAUDE.md:73` → research link |
| 4 | `dom-selection/CLAUDE.md:110`, `element-size/CLAUDE.md:39`, `in-view/CLAUDE.md:48` → lint-rule links; `auto-scroll/CLAUDE.md:5,25` → lint-plugin + research links |

Plus the hand edits v1 enumerates for wave 1 (two lint-message pointer strings, four
lint-test fixture paths, and `pane/CLAUDE.md:410,559`), and per-wave prose labels in
consumer CLAUDE.mds (`` `primitives/tooltip` `` → `` `primitives/overlay/tooltip` ``).
The `Imported by:` / `Uses:` autogen blocks regenerate.

**Everything else is automatic.** The `@plugins/*` alias, the runtime tsconfig
`**/plugins/*/<runtime>` globs and `workspaces: ["plugins/**"]` are all globstar and absorb
the extra depth. The three generated registries, both docs files and every autogen CLAUDE.md
block rebuild from the filesystem. Plugin ids derive positionally from the directory tree —
nothing hardcodes them.

## Verification

Per wave, before checkpointing:

1. `rg -n "plugins/<um>/plugins/(<member>|…)/" -g '!research/**' -g '!node_modules'`
   → **zero hits**.
2. `rg -n "scope/plugins/scoped-store/plugins/dom-scope"` → **zero hits** (wave 1 only —
   the exact signature of the rule-order mistake).
3. `rg -rn '\.\./\.\./\.\.' plugins/<um>/plugins/<group>/` → every hit resolves. Walk them.
4. `./equin check` green — `type-check` proves imports resolve, `plugin-refs-resolve`
   catches stale `plugins/…` string literals by name, `plugins-registry-in-sync` and
   `plugins-doc-in-sync` prove the regenerated artifacts are committed,
   `plugins-have-claudemd` proves the new umbrella has one, `plugin-boundaries` proves no
   import reaches inside a barrel at the new depth.
5. `./equin test plugins/<um>/plugins/<group>` — the suites that came along must still
   run from the new path (wave 1: 4 test suites + 4 lint-rule suites; wave 4: `overscroll-hint`
   and `copy-source-text` also carry `e2e/`).
6. `git diff --stat $(git merge-base HEAD main)` — renames, import-string edits, the listed
   hand edits, regenerated artifacts. **No logic changes.** A changed `.ts` body means
   something went wrong.

After wave 5, one Playwright pass at `http://<worktree>.localhost:9000` over the surfaces
these primitives own, since a lost sink or surface id is a runtime failure type-check cannot
see: open a page and confirm the outline rail tracks; ⌘-click a link to open a second tab and
confirm the rail still tracks in the focused one; switch to floating-window placement and
tile/close a window; open a tooltip, a popover and a confirm dialog; scroll a long transcript
to confirm stick-to-bottom and the overscroll bounce.

## Deferred — filed as separate tasks

Not a scoping convenience: each of these carries something wave 1 does not.

| Umbrella | refs | Why deferred |
|---|---|---|
| `primitives/collections/` | 439 | `data-view` owns **three** user-override config files across ~140 worktrees. Blocked on the rename script. Membership also arguable — `keyset` is server-side SQL pagination, not a collection widget |
| `primitives/text/` | 148 | `prompt-editor` owns a user reorder layout (70 worktrees). Blocked on the same script. `collab-doc` is a drizzle column type — membership arguable |
| `primitives/chrome/` | 231 | No config risk, but membership genuinely undecided: `icon-button` (116 refs) composes Button+Tooltip from `css/ui-kit`, and `avatar` composes `icon-picker`, which is in no proposed group |
| `infra/process/` | 161 | No config risk, but `spawn` (148 refs) is build-and-CLI-critical. A broken build tool cannot rebuild itself, so this wants its own checkpoint and its own rollback story |

And the prerequisite both config-carrying umbrellas need: **a config-hierarchy rename
script**, modelled on `plugins/framework/plugins/tooling/plugins/codegen/scripts/slot-config-rename.ts`
— a committed old→new hierarchy table plus a hand-run `--apply` pass that walks every
worktree's user config dir. Whether it should instead be a build-time migration that reads
the rename table automatically is itself a design question worth answering there, since the
`ea280bee0` lesson is that a manual post-step is exactly what gets skipped.

## Risks

- **Rule order** in the substitution pass — mitigated by longest-first and by a grep for the
  exact wrong string.
- **Deep relative paths** — six known, listed above; re-run the `../../..` grep after each
  wave to catch any that appear.
- **Wave 5 is the biggest at 91 refs** and `tooltip`/`popover` are used by nearly every
  surface. It is last for that reason: by then the recipe has been proven four times.
- **`plugin_health_reviews` rows go stale** for 28 plugin ids — regenerable per-worktree
  state, not committed. Accepted, no migration; the same call the 13-plugin rehome made.
- **Five wide mechanical diffs.** One commit per wave so each is bisectable and reads as a
  relocation. Do **not** push without explicit approval.
