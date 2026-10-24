# Saved config follows a plugin move

## Context

A plugin's saved settings live on disk under a folder named after the plugin id.
The user's own copy sits at `~/.singularity/state/config/<namespace>/<plugin/slash/path>/`.
Moving a plugin changes its id, so the settings folder no longer matches.

What happens today on `./equin plugin move`:

- The committed defaults under `config/` move with `git mv`. Fine.
- Saved reorder layouts inside committed files get their `"<pluginId>:<id>"` keys rewritten. Fine.
- The user's own copy (every namespace under `~/.singularity/state/config/`) is **not touched**.
  `move.ts` prints the stranded folders and stops (`plugins/plugin-meta/plugins/relocate/cli/move.ts:118`, `:279`).
- Saved reorder layouts in the user's copy keep the old plugin id in their keys, in *every* slot's file,
  not only under the moved plugin. Those entries stop matching and the slot falls back to its default order.

So the user's saved DataView state, gallery layout, settings nav order and reorder layouts silently revert.
This blocks the `collections/` and `text/` umbrella moves (data-view and prompt-editor carry ~140 worktrees of saved state).

A hand-run script (the `slot-config-rename.ts` precedent) is the wrong shape: it is a step someone must remember.
The fix should make "moved the code but not the saved settings" impossible to ship.

### Is orphaned config flagged in the config app today?

**No.** Only Debug → Config Orphans shows it (`plugins/debug/plugins/config-orphans`), and only if you go look.
The Settings app never mentions it, no report is filed, and the health dot stays green.
`auditUserConfigOrphans` (`plugins/config_v2/server/internal/orphan-audit.ts`) already sorts orphans into
"stranded user data" vs "noise" and guesses "relocated", but it writes nothing and tells no one.

## Design: a committed move ledger, applied by the build

Treat a plugin move like a database migration: the move that changes the code also records
what changed, in the repo. Every build then brings its own namespace's saved settings up to date.

### 1. The ledger (owned by config_v2)

A committed, append-only list of plugin-id moves: `plugins/config_v2/core/plugin-moves.json`,
`[{ "from": "primitives.data-view", "to": "primitives.collections.data-view" }, …]`.

- `./equin plugin move` appends one entry, in the same commit as the code move.
  No human step: the entry is written by the tool that makes the move.
- Entries are ordered; chains (`A→B`, then `B→C`) apply in order.
- A check (`config_v2:plugin-moves-valid`) rejects an entry whose `to` is not a live plugin id at HEAD
  unless a later entry moves it on, and rejects edits to earlier entries (append-only, compared against merge-base).

### 2. Applying it (build, before config propagation)

New `applyPluginMoves({ userConfigDir, moves })` in config_v2 server, called from
`plugins/framework/plugins/cli/plugins/build/cli/internal/deploy-namespace.ts:493`
immediately **before** `propagateConfigToUser`. The build already touches exactly this namespace's
folder there, so this is the one place that runs on every checkout's code version.

Per namespace, it keeps `<userConfigDir>/.plugin-moves-applied` (the count of ledger entries applied).
For each not-yet-applied entry, in order:

1. **Move the folder.** Every file under `<from path>/` (including `@app/` scoped overrides and
   descendants' folders) moves to the same relative spot under `<to path>/`.
   If a destination file already exists (the user already saved something at the new place),
   the destination wins and the source file stays where it is — it then shows up as a flagged orphan (below).
   Never overwrite, never delete a real override.
2. **Rewrite reorder keys everywhere in the namespace.** Every `items` string `"<from>:<id>"` or
   `"<from>.<sub>:<id>"` becomes `"<to>…:<id>"`, in `.jsonc`, `.origin.jsonc` and `.ancestor.jsonc` files.
   Reuse the exact locator the git-layer rewrite already uses: `scanReorderItemRefs`
   (`plugins/plugin-meta/plugins/plugin-refs/core/config-refs.ts:103`) — moving it (or its core)
   to where config_v2 can import it without a cycle.
3. **Keep the hash chain intact.** An override records the hash of the default it was written against.
   Rewriting a default's keys changes its hash, which would mark the override stale and make the default
   win — the exact loss we are preventing. So: rewrite `.origin`/`.ancestor` first, collect `oldHash → newHash`,
   then re-stamp each override's `// @hash` through that map. Result: after migration, the user's copy of the
   default equals the new committed default byte-for-byte, and `propagate` sees no change and no conflict.
4. Bump the counter after the entry fully succeeds. Any error fails the build loudly, naming the file.

Why this covers every namespace without a manual pass:

- The worktree that made the move: its next build applies it.
- Main: the push triggers main's auto-build, which applies it to main's folder.
- New worktrees: `forkConfig` copies main's folder (counter included), already migrated.
- Old worktrees: their code predates the move, so their settings still match their code.
  When they rebase and build, the entry arrives with the code and applies then.

Code and saved settings change together, per checkout. No window where they disagree.

### 3. `plugin move` stops reporting stranded dirs as a to-do

`move.ts` appends the ledger entry instead of printing "NOT moved". It still prints what the next build will migrate
(dry-run count per namespace) so the review shows the effect.

### 4. Flag leftover orphans where the user will see them

Orphans can still happen (a plugin deleted, a destination conflict in step 1, a move made before this ships).
The audit already knows which ones hold real user data. Make it visible:

- **Report**: at boot, run `auditUserConfigOrphans` and file one rolling `config-orphans-stranded` report
  (error level) when any `stranded-data` entry exists. It lands in the bell and Debug → Reports, with the
  existing on-demand Investigate button. `noise` entries never report.
- **Settings**: the config nav shows an "Unapplied saved settings (N)" entry at the top when there are stranded
  entries, opening the existing Config Orphans panel (reused, not duplicated).
- The audit's "relocated" guess becomes certain when the ledger names the move; the panel says
  "moved to X — will migrate on next build" vs "plugin removed".

### 5. Retire the one-off

Once shipped, `slot-config-rename.ts` + `plugins/reorder/shared/slot-id-rename.json` are superseded
(different key shape — slot-name renames, not plugin moves). Leave them; note in the doc they should not be copied.

## Out of scope (noted by `move.ts` already)

- DB rows keyed by plugin id (`plugin_health_reviews`, etc.). Separate task if needed.
- The historical mis-moves already on disk (e.g. the `primitives.data-view.*.origin.jsonc` leftovers in main's
  folder are old-scheme noise; the audit classifies them).

## Files

- `plugins/config_v2/core/plugin-moves.json` (new ledger) + a core reader.
- `plugins/config_v2/server/internal/apply-plugin-moves.ts` (new) + test next to it.
- `plugins/config_v2/check/` — ledger validity check.
- `plugins/framework/plugins/cli/plugins/build/cli/internal/deploy-namespace.ts` — call before propagation.
- `plugins/plugin-meta/plugins/relocate/cli/move.ts` — append entry, replace the stranded warning.
- `plugins/plugin-meta/plugins/plugin-refs/core/config-refs.ts` — share the reorder-key locator.
- `plugins/config_v2/server/internal/orphan-audit.ts` — read the ledger for `reason`.
- A report kind for stranded orphans; Settings config-nav entry (`plugins/config_v2/plugins/settings/web/components/config-nav.tsx`).
- `plugins/config_v2/CLAUDE.md` — document the ledger.

## Verification

- Unit test `applyPluginMoves` on a temp folder: folder move, nested `@app`, reorder keys in an unrelated slot's file,
  override stays non-stale (`effective()` returns the override), destination conflict leaves source in place,
  chain `A→B→C`, re-run is a no-op.
- End to end in this worktree: `plugin move` a small plugin that has a saved override and a reorder entry,
  `./equin build`, confirm the override still applies in the UI (screenshot) and Debug → Config Orphans is empty.
- `./equin check` passes; a hand-edited earlier ledger entry fails the check.
