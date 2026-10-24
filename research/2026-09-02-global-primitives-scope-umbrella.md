# `primitives/scope/`: the first umbrella out of the flat primitives list

**Date:** 2026-09-02
**Category:** global
**Status:** Plan — awaiting approval

## Context

`plugins/primitives/plugins/` holds **95** entries and `plugins/infra/plugins/` holds
**37**, both flat. The root CLAUDE.md asks that `plugins/` read as semantic categories
rather than an unbounded list; at this size neither umbrella does. The practical cost is
that finding out whether a primitive for some concept already exists means scanning a
95-line list, which is how the same idiom ends up hand-rolled in three places before
anyone notices.

A rule now sits at the top of both `plugins/primitives/CLAUDE.md` and
`plugins/infra/CLAUDE.md` telling agents not to add a top-level entry without approval.
That stops the list growing. It does not group what is already there.

`research/2026-09-01-global-instance-scoped-dom-root.md` sketched the groupings that fall
out of the current list. This plan lands the one with the most support — **`primitives/scope/`**,
*which mounted instance does this belong to, and how do I reach mine?* — and nothing else.
That plan created two of the six members and nested one under another as an explicit
stopgap, so this is the natural first move and the stopgap ends here.

Behaviour is unchanged. This is a pure relocation.

### Two decisions taken (flag them at approval if you disagree)

1. **Six members, `install-sink` included.** It is the deliberate opposite — one
   implementation for the whole page, and its own source says *"Process-global is the point
   here"*. It belongs next to the others precisely because the reader choosing a lifetime is
   choosing between them. Leaving it out would mean the two halves of one decision live in
   two places.
2. **`dom-scope` is promoted to a sibling of `scoped-store`**, not kept nested under it.
   The nesting was a stopgap to avoid a 96th top-level entry, and the umbrella removes the
   reason for it. As a sibling the import path gets shorter rather than deeper, and `scope/`
   reads as six peers. That `dom-scope` is a façade over `defineScopedStore` stays a
   sentence in its CLAUDE.md — which is where the other five state their relationships too.

`shortcuts` is the per-instance *keyboard* row of the same table and would be a defensible
seventh. It is left out: it is load-bearing, an order of magnitude larger than the other
six, and its identity reads as "keyboard registry" first. Moving it is a separate call.

## The move

```
plugins/primitives/plugins/scope/
├── CLAUDE.md        ← new (hand prose + autogen block)
├── package.json     ← new
└── plugins/
    ├── app-instance/     ← from primitives/plugins/app-instance
    ├── dom-scope/        ← from primitives/plugins/scoped-store/plugins/dom-scope
    ├── install-sink/     ← from primitives/plugins/install-sink
    ├── scoped-store/     ← from primitives/plugins/scoped-store
    ├── surface-id/       ← from primitives/plugins/surface-id
    └── tab-id/           ← from primitives/plugins/tab-id
```

| Current | Target | New plugin id |
|---|---|---|
| `primitives/plugins/scoped-store/plugins/dom-scope` | `primitives/plugins/scope/plugins/dom-scope` | `primitives.scope.dom-scope` |
| `primitives/plugins/scoped-store` | `primitives/plugins/scope/plugins/scoped-store` | `primitives.scope.scoped-store` |
| `primitives/plugins/surface-id` | `primitives/plugins/scope/plugins/surface-id` | `primitives.scope.surface-id` |
| `primitives/plugins/tab-id` | `primitives/plugins/scope/plugins/tab-id` | `primitives.scope.tab-id` |
| `primitives/plugins/app-instance` | `primitives/plugins/scope/plugins/app-instance` | `primitives.scope.app-instance` |
| `primitives/plugins/install-sink` | `primitives/plugins/scope/plugins/install-sink` | `primitives.scope.install-sink` |

Top-level primitives entries: **95 → 91**.

All six are pure web-runtime leaves — `web/` only, no `core/`, no `server/`, no `e2e/`.
Two carry a `lint/` dir (`scoped-store`, `install-sink`), one carries a `check/` dir
(`dom-scope`). Total importer blast radius is **~45 source files**, small enough to land in
one commit and read as a relocation.

## What a move touches

Mechanics verified against the same surfaces the 13-plugin rehome
(`c7a7aab7b`, `research/2026-06-12-global-rehome-top-level-leaf-plugins.md`) enumerated.
That doc is the template; this move is a strictly smaller instance of it.

| Surface | Update | Auto via `build`? |
|---|---|---|
| `web.generated.ts`, `check.generated.ts`, `lint.generated.ts` (+ composition-filtered siblings) | regenerated from disk | ✅ **do not hand-edit** |
| `docs/plugins-compact.md`, `docs/plugins-details.md`, per-plugin `CLAUDE.md` autogen blocks (incl. `Imported by:` lists) | regenerated; `plugins-doc-in-sync` gates | ✅ |
| `@plugins/*` alias (`tsconfig.base.json:16`), runtime tsconfig `**/plugins/*/web` globs, `workspaces: ["plugins/**"]` | all globstar — absorb the extra depth | ✅ nothing to edit |
| `boundary-config.ts` | names only `plugin-meta/plugin-tree`, `packages/retry`, `packages/semaphore`, `infra/secrets`, `infra/paths` — **none of ours** | ✅ nothing to edit |
| Import specifiers + bare `plugins/…` path literals | rewrite | ❌ **manual (scripted)** |
| 2 lint-message pointer strings, 4 lint-test fixture paths, 3 hand-written CLAUDE.md links | rewrite | ❌ **manual** |
| `plugin_health_reviews.plugin_id` rows | orphaned — regenerable per-worktree state, accepted | n/a |

Three things that bite on other moves and **do not bite here** — each verified, not assumed:

- **No `config/` dirs and no `config_v2` descriptors.** `config/primitives/` holds only
  `css`, `data-view`, `prompt-editor`, `text-editor`. A `grep` for `defineConfig` /
  `config_v2` across all six returns nothing. So there is no `config/<hier>/` dir to
  `git mv`, no stranded-override build failure, and no unversioned user-layer config under
  `~/.singularity/state/config/` to relocate or lose. This is the one category that would
  otherwise break *silently*, and it is absent.
- **No slot contributions.** All six barrels are `contributions: []` and none calls
  `defineRenderSlot` / `defineMountSlot`. No saved reorder layout names them, so no
  `pluginId:id` entryKey goes stale.
- **Lint namespaces and check ids are hand-authored literals, not path-derived.**
  `install-sink/no-render-phase-peek`, `scoped-store/no-module-mutable-store` and
  `dom-scope:bounded-attr-not-document-wide` keep their names, so no
  `eslint-disable-next-line` comment anywhere in the repo changes.

### The one hazard in the scripted pass: rule order

`dom-scope`'s current path is *inside* `scoped-store`'s. Applying the `scoped-store` rule
first turns a `dom-scope` import into
`…/scope/plugins/scoped-store/plugins/dom-scope/` — wrong, and it still type-checks against
nothing so only `plugin-refs-resolve`/`tsc` would catch it. **Longest prefix first.**

Rewrite the **bare** form, which covers both `@plugins/…` specifiers and plain
`plugins/…` string literals in one pass (`@plugins/x` contains `plugins/x`):

```
plugins/primitives/plugins/scoped-store/plugins/dom-scope/  →  plugins/primitives/plugins/scope/plugins/dom-scope/
plugins/primitives/plugins/scoped-store/                    →  plugins/primitives/plugins/scope/plugins/scoped-store/
plugins/primitives/plugins/surface-id/                      →  plugins/primitives/plugins/scope/plugins/surface-id/
plugins/primitives/plugins/tab-id/                          →  plugins/primitives/plugins/scope/plugins/tab-id/
plugins/primitives/plugins/app-instance/                    →  plugins/primitives/plugins/scope/plugins/app-instance/
plugins/primitives/plugins/install-sink/                    →  plugins/primitives/plugins/scope/plugins/install-sink/
```

Trailing-slash anchored. No rule's output re-matches any rule's input, so after the
longest-first ordering the pass is idempotent. Apply across `**/*.{ts,tsx}`,
**skipping `*.generated.ts`**. Do **not** touch `research/*.md` — those are dated records of
what was true when written, not live references.

## Execution

### Step 1 — Scripted core (serial, one operator)

1. `mkdir -p plugins/primitives/plugins/scope/plugins`, then `git mv` each of the six
   directories to its target. Move `dom-scope` **before** `scoped-store`, since it currently
   lives inside it.
2. Write `plugins/primitives/plugins/scope/package.json` — mirror
   `plugins/primitives/plugins/outline/package.json` exactly:
   `{ "name": "@singularity/plugin-primitives-scope", "description": "…", "private": true, "version": "0.0.1" }`.
   The `description` is what docgen renders as the umbrella's line in `plugins-compact.md`,
   so write it properly: *"Which mounted instance does this belong to, and how do I reach
   mine? — my instance's state (scoped-store), my instance's DOM node (dom-scope), the ids
   that name an instance (surface-id / tab-id / app-instance), and the deliberate opposite:
   one implementation for the whole page (install-sink)."*
3. Write `plugins/primitives/plugins/scope/CLAUDE.md` — a short hand-written intro (the
   category question, and a one-line "reach for which" table across the six) followed by the
   `<!-- AUTOGENERATED:BEGIN -->` / `END` markers for build to fill. Copy the marker spelling
   from `plugins/primitives/plugins/outline/CLAUDE.md`.
4. Apply the six-rule substitution table, longest-first, over `**/*.{ts,tsx}` excluding
   `*.generated.ts`.

### Step 2 — The hand edits the script cannot make

These are the complete set; each was found by grep, not guessed.

| File | Edit |
|---|---|
| `…/scope/plugins/install-sink/CLAUDE.md:114` | **Depth-sensitive.** `](../../../../research/…)` → `](../../../../../../research/…)`. The plugin gains two path segments. This is the exact class that broke `app.css`'s `@source` glob in `ea280bee0` after a relocation — the only such link in the six, but it must be walked, not sed'd |
| `…/scope/plugins/scoped-store/lint/no-module-mutable-store.ts:138,142` | pointer strings in the error message naming `@plugins/primitives/plugins/{scoped-store,install-sink}/web` — covered by the table, but re-read the rendered message afterwards |
| `…/scope/plugins/install-sink/lint/no-adhoc-install-sink.ts:157` | same, one string |
| `…/scope/plugins/install-sink/lint/no-adhoc-install-sink.test.ts:37,49,57` | three fixture filenames under the old plugin path — covered by the table; these are what `plugin-refs-resolve` would fail on if missed |
| `plugins/page/plugins/editor/lint/no-adhoc-block-id.test.ts:40` | fixture filename `plugins/primitives/plugins/tab-id/web/tab-id.ts` — covered by the table |
| `plugins/primitives/plugins/pane/CLAUDE.md:410,559` | `](../install-sink/CLAUDE.md)` → `](../scope/plugins/install-sink/CLAUDE.md)` |
| CLAUDE.md prose in the six + `page/editor`, `apps-core/tabs`, `overlay-boundary`, `latest-ref` | prose labels like `` `primitives/install-sink` `` → `` `primitives/scope/install-sink` ``. Hand-written sections only — the `Imported by:` / `Uses:` autogen blocks regenerate |

`…/scope/plugins/scoped-store/CLAUDE.md:72`'s `](../install-sink/CLAUDE.md)` needs **no
change**: both files move into the same `scope/plugins/` directory, so the relative link
still resolves. Verify rather than assume.

### Step 3 — Regenerate and validate (serial)

1. `./equin build` — **`run_in_background: true`, then end the turn**. Regenerates the
   three registries, the docs, and every autogen CLAUDE.md block; `bun install` picks up the
   new workspace member. Confirm `status: ok` in
   `~/.singularity/worktrees/<wt>/build-status.json` — never infer a deploy from a log file's
   mtime.
2. `./equin check` and iterate to green. The checks that carry this refactor:
   - `type-check` — proves every import resolves.
   - `plugin-refs-resolve` — the safety net for hand-authored `plugins/…` string literals;
     it enumerates each unresolved reference with the hint *"A plugin was likely moved or
     renamed"*. This is what catches a missed lint-test fixture.
   - `plugins-registry-in-sync`, `plugins-doc-in-sync` — prove the regenerated artifacts are
     committed.
   - `plugins-have-claudemd` — proves the new umbrella has its CLAUDE.md.
   - `plugin-boundaries` — proves no import reaches inside a barrel at the new depth.
   - `dom-scope:bounded-attr-not-document-wide` — derived from `defineDomScope` declarations,
     so it should pass untouched; if it does not, the move broke discovery.

## Verification

1. `rg -n "plugins/primitives/plugins/(scoped-store|surface-id|tab-id|app-instance|install-sink)/" -g '!research/**' -g '!node_modules'`
   → **zero hits**. (`research/` keeps its historical spellings on purpose.)
2. `rg -n "scope/plugins/scoped-store/plugins/dom-scope"` → **zero hits** — this is the
   specific signature of the rule-order mistake, and nothing else looks like it.
3. `./equin check` green, `./equin build` reports `status: ok`.
4. `./equin test plugins/primitives/plugins/scope` — the four suites that came along
   (`scoped-store`, `dom-scope`, `app-instance`, `install-sink`) plus the four lint-rule
   suites must all still run and pass from the new path.
5. Playwright smoke at `http://<worktree>.localhost:9000` over the surfaces that consume
   these six, since a broken sink or a lost surface id is a runtime failure a type-check
   cannot see: open a page and confirm the outline rail tracks (`dom-scope`); ⌘-click a link
   to open a second tab and confirm both render and the rail still tracks in the focused one
   (`scoped-store` + `surface-id`); switch to floating-window placement and tile/close a
   window (`install-sink` + `app-instance`); open the notifications bell (`tab-id`).
6. `git diff --stat $(git merge-base HEAD main)` — the diff must be renames, import-string
   edits, the seven hand edits above, and regenerated artifacts. **No logic changes.** If a
   `.ts` file shows a body change, something went wrong.

## Risks

- **Rule order in the substitution pass** is the one way to produce a wrong-but-plausible
  path. Mitigated by longest-first ordering and by verification step 2, which greps for the
  exact wrong string.
- **Depth-sensitive relative paths.** `ea280bee0` is the precedent: a hardcoded
  `@source` glob silently narrowed after a plugin moved two levels deeper, and the
  regression was only caught after the fact. The audit here found exactly one such path
  (`install-sink/CLAUDE.md:114`) and confirmed the Tailwind `@source` glob lives in
  `css/ui-kit` and points at `plugins/` root, so it is unaffected. Re-run the
  `grep -rn '\.\./\.\./'` over the six after the move to confirm nothing new appeared.
- **`plugin_health_reviews` rows go stale** for six plugin ids. Regenerable per-worktree
  review state, not committed — accepted, no migration, same call the 13-plugin rehome made.
- **Wide, mechanical diff.** Land as one focused commit so a reviewer reads it as a
  relocation. Do **not** push without explicit approval.

## Not this plan's work

The remaining groupings in the 2026-09-01 sketch (`dom/`, `overlay/`, `collections/`,
`text/`, `chrome/`, and for infra `host/`, `git/`, `process/`, `store/`) stay **proposals,
not decisions**. Each is its own task, run when nothing else is mid-flight, and each wants
its own membership argument — the reason `scope/` goes first is that its membership was
already derived from a real sub-class table rather than from surface similarity of names.
Worth filing them once this lands and the mechanics are proven at this scale.
