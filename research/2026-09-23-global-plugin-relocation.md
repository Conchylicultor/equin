# Plugin relocation: one command, and no hand-restated identity

## Context

Moving a plugin is routine (≥7 times so far) and every time it is bespoke and risky —
`ea280bee0` shipped a silently-narrowed Tailwind `@source` glob fixed 21 min later, and the
2026-09-02 umbrella wave (`research/2026-09-02-global-primitives-scope-umbrella-v2.md`) hit
three classes of restated identity:

1. `package.json` `"name"` — fully determined by the path (R1's `expectedPackageName()` in
   `checks/plugins/plugin-boundaries/check/index.ts:463`), read by nothing (no source imports
   `@singularity/plugin-*`, `bun.lock` is keyed by path, `no-plugin-workspace-deps` bans
   `workspace:*`). A write-only value a human must type.
2. Dot-form ids (`infra.git-watcher.**`) — validated only in reorder `items` entry keys;
   the composition manifest (`config/plugin-meta/composition/compositions.origin.jsonc`,
   ~82 literals), `asPluginId("…")` source literals and `boundary-config.ts`
   `runtimeExceptions` are unchecked. A dead id silently weakens `composition-closure`.
3. Relative markdown links — nothing validates them; 23 are broken on main today.

Goal: every plugin reference is either **derived** or **found by one locator** that both a
check validates and a mover rewrites — then `./equin plugin move <from> <to>` does the
whole relocation, and the checks prove nothing was missed.

Out of scope (filed separately): migrating user-layer config (`~/.singularity/…/config/<old>`)
and the remaining umbrella groupings. The mover only *reports* stranded user config.

## Design

### A. `package.json` name is derived by build (fixes 1)

- `regenerateRegistryCodegen` (shared by `build` and `regen-generated`) gains a step that
  writes each plugin `package.json`'s `"name"` to `expectedPackageName(path)`, touching only
  that field (preserve key order/formatting; skip composition roots as R1 does).
- Move `expectedPackageName` out of the plugin-boundaries check into
  `plugins/framework/plugins/plugin-id/core` next to `asFsPath`, so codegen and the check
  share one spelling.
- R1 stays as the in-sync guard (same role as `plugins-registry-in-sync`), with its hint
  changed to "run `./equin build`". A new plugin's `package.json` can then be written
  without a name at all… only if bun accepts a nameless workspace member — **verify first**;
  if not, the generator fills a placeholder-free name on first build and that's enough.

### B. One plugin-reference locator (fixes 2, feeds the mover)

New plugin `plugins/plugin-meta/plugins/plugin-refs/` with a `core` barrel:

```ts
type PluginRef =
  | { kind: "path"; file; range; value }        // "plugins/a/plugins/b/…" literals, @plugins/ specifiers
  | { kind: "dot";  file; range; value }        // dot-form id, optionally ".**" / "!" / ":slot"
  | { kind: "relative"; file; range; value };   // relative link/path to be re-relativized (C)
findPluginRefs(repo: RepoFiles): Promise<PluginRef[]>
```

Dot refs are found **structurally, never by free-text regex** (a top-level id like `search`
has no dot, so prose cannot be rewritten safely):
- compositions manifest: parse jsonc, read `entryPoints` / `selectedContributors` /
  `excludes` / `extends` through `parseEntryPattern`
  (`plugins/plugin-meta/plugins/closure/core/entry-pattern.ts`);
- reorder override `items` entry keys (lifted from today's `plugin-refs-resolve` Surface C);
- `asPluginId("…")` string arguments in non-test `.ts`;
- `boundary-config.ts` `runtimeExceptions` via the existing `parseRuntimeException`.

Path refs reuse `plugin-refs-resolve`'s current Surface A/B scanner (`grepCode` +
`pluginPathFromLiteral` + `pluginDirPrefix`) moved into this core, extended to `@plugins/…`
import specifiers (type-check already validates those; the mover needs to find them).

`plugin-refs-resolve` becomes a thin consumer: every `path`/`dot` ref must resolve against
`buildStructureTreeOnce()`'s path/id sets. Test fixtures (`*.test.ts`) excluded as today.

### C. Relative links resolve (fixes 3)

New check `plugin-refs:relative-links-resolve` (contributed `check/` in the plugin-refs plugin):
every relative target in tracked `*.md` — `[x](rel)`, `[x]: rel`, `<img src>` — resolves to
an existing file/dir (anchor `#…` and query stripped; `http(s):`, `mailto:`, absolute and
code-fenced/inline-code spans ignored). Sources under `research/` are excluded (dated
records; their targets legitimately get deleted), but links *into* research are checked.
The same locator emits these as `relative` refs, plus CSS `@source`/`@import` relative
paths (the `ea280bee0` class) — the check validates the CSS ones too (a glob's static
prefix must exist).

Land with the 23 pre-existing broken links fixed.

### D. `./equin plugin move <from> <to> [--dry-run]`

New plugin `plugins/plugin-meta/plugins/relocate/` with `cli/index.ts`
(`defineCliCommand` group `plugin`, subcommand `move`; body lazy-imported). Arguments accept
either path (`plugins/primitives/plugins/tooltip`) or dot id (`primitives.tooltip`); a
rename is a move with a new basename.

1. **Refuse** unless: in a worktree (not main), clean tree, `<from>` is a plugin, `<to>`'s
   parent is `plugins/` or an existing plugin (its `plugins/` dir created if needed), `<to>`
   does not exist, `<to>` is not inside `<from>`.
2. **Mapping** for the plugin and every descendant: old→new fs path, dot id, config slash
   path (`asFsPath` / `asPath`).
3. **Locate before moving**: `findPluginRefs` over tracked files, keep refs whose target is
   in the moved subtree (plus every `relative` ref whose *source* file is in the subtree).
4. `git mv` the plugin dir; `git mv config/<old slash path>` → `config/<new>` if present.
5. **Rewrite**, per file, edits applied back-to-front by range (so nested moves can't
   double-rewrite — this kills the "longest prefix first" hazard by construction):
   - path/dot refs: swap the mapped prefix;
   - relative refs: resolve against the source's *old* location → map target through the
     move → re-relativize from the source's *new* location.
   Skips `*.generated.ts`, `bun.lock`, and prose in `research/` (only its links).
6. Package names: nothing (A). Registries, docs, CLAUDE.md autogen blocks: regenerated by build.
7. **Report**: files touched per kind; user-layer config dirs under any old slash path
   across worktrees (not moved — separate task); `plugin_health_reviews` rows that orphan.
   Print next step: `./equin build` then `./equin check`.

`--dry-run` prints the plan (moves + per-file edit counts) and exits.

## Critical files

- `plugins/framework/plugins/tooling/plugins/checks/plugins/plugin-boundaries/check/index.ts` (R1, `expectedPackageName`)
- `plugins/framework/plugins/tooling/plugins/checks/plugins/plugin-refs-resolve/check/index.ts` (becomes consumer)
- `plugins/framework/plugins/plugin-id/core/plugin-id.ts` (gains `packageNameFor`)
- `plugins/framework/plugins/tooling/plugins/codegen/…` `regenerateRegistryCodegen` (writes names)
- `plugins/plugin-meta/plugins/closure/core/entry-pattern.ts` (reused parser)
- `plugins/framework/plugins/tooling/plugins/boundaries/core/check.ts` (`parseRuntimeException`, reused)
- new: `plugins/plugin-meta/plugins/plugin-refs/{core,check}`, `plugins/plugin-meta/plugins/relocate/cli`
- reference shape for the CLI group: `plugins/framework/plugins/cli/plugins/upstream/cli/index.ts`

## Order

A → B (check green on main first) → C (fix the 23) → D. Each is independently useful.

## Verification

- Unit tests (`./equin test plugins/plugin-meta/plugins/plugin-refs …/relocate`):
  locator on fixtures for each ref kind; re-relativize math incl. depth change; nested move
  (parent + child both mapped) rewrites each ref exactly once.
- Checks: plant a stale dot id in the compositions manifest, a stale `runtimeExceptions`
  edge and a broken CLAUDE.md link → each check fails naming file:line; remove → green.
- End-to-end on a scratch branch: replay a real past move with the command, e.g.
  `./equin plugin move primitives.overlay.tooltip primitives.tooltip` (a depth change
  over a widely-imported plugin), and `primitives.dom.auto-scroll` (CLAUDE.md links to
  research and lint rules). Then
  `./equin build` (background) → `status: ok`, `./equin check` green,
  `git diff --stat $(git merge-base HEAD main)` shows only renames + reference edits +
  regenerated artifacts. Revert the scratch move.
