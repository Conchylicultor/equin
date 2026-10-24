# Unified generated-file conflict resolution in `./equin push`

## Context

Agents frequently hit push failures when two agents both modify generated files (like `web.generated.ts` plugin registries). The push command has a two-layer auto-resolve system — git merge drivers that accept the upstream side during rebase, and a `postRebaseNormalize` step that regenerates canonical content afterward — but it only covers docs and migrations. Eight `*.generated.ts` files, two `*.origin.jsonc` files, and `docs/routes.md` have no merge driver, causing rebase conflicts that block pushes.

The fix: collapse all purely-deterministic generated files (docs + codegen) into a single `generated` marker and delete the now-redundant `regen-docs` driver/script. Migrations stay separate (hand-edit safety check + drizzle-kit). Result: 3 drivers total (`regen-generated`, `regen-claudemd`, `regen-migrations`) down from 3+gaps.

## Files not currently covered

| File | Generator |
|---|---|
| `plugins/**/*.generated.ts` (8 files) | `generatePluginRegistry`, `generateBarrelStubs` |
| `config/**/*.origin.jsonc` (2 files) | `generateConfigOrigins` |
| `docs/routes.md` | `generatePluginDocs` |

## Implementation

### 1. New merge driver script: `regen-generated.sh`

**File:** `plugins/framework/plugins/cli/scripts/regen-generated.sh` (new, `chmod +x`)

Accept upstream, drop `generated` marker — replaces `regen-docs.sh`:

```sh
#!/bin/sh
GITDIR=$(git rev-parse --git-dir)
mkdir -p "$GITDIR/singularity-merge-markers"
touch "$GITDIR/singularity-merge-markers/generated"
exit 0
```

### 2. Delete `regen-docs.sh`

**File:** `plugins/framework/plugins/cli/scripts/regen-docs.sh` (delete)

Now redundant — `regen-generated.sh` is byte-for-byte the same logic. All `.gitattributes` entries that pointed to `merge=regen-docs` are repointed to `merge=regen-generated` (step 4).

### 3. Update marker in `regen-claudemd.sh`

**File:** `plugins/framework/plugins/cli/scripts/regen-claudemd.sh`

Change `touch "…/docs"` → `touch "…/generated"`. Behavior unchanged: still does 3-way merge for prose; only the marker name changes.

### 4. Update `.gitattributes`

Replace all entries. `regen-docs` driver references become `regen-generated`:

```gitattributes
# Auto-generated artifacts: resolved by custom merge drivers in plugins/framework/plugins/cli/scripts/
# plus a post-rebase normalize step in `./equin push` that regenerates
# canonical content from the rebased source tree.

# Plugin docs (fully generated)
docs/plugins-compact.md                       merge=regen-generated
docs/plugins-details.md                       merge=regen-generated
docs/routes.md                                merge=regen-generated

# Per-plugin CLAUDE.md (mixed: hand-written prose + autogen block)
plugins/**/CLAUDE.md                          merge=regen-claudemd

# Plugin registry codegen
plugins/**/*.generated.ts                     merge=regen-generated

# Config origin files
config/**/*.origin.jsonc                      merge=regen-generated

# Database migrations (separate: hand-edit safety check before regen)
plugins/database/plugins/migrations/data/*.sql                merge=regen-migrations
plugins/database/plugins/migrations/data/meta/_journal.json   merge=regen-migrations
plugins/database/plugins/migrations/data/meta/*_snapshot.json merge=regen-migrations
```

### 5. Update `register-merge-drivers.ts`

**File:** `plugins/framework/plugins/cli/bin/git/register-merge-drivers.ts`

- Replace the `regen-docs` driver entry with `regen-generated` pointing to `regen-generated.sh`
- Net result: 3 drivers (`regen-generated`, `regen-claudemd`, `regen-migrations`)

### 6. New CLI subcommand: `regen-generated`

**File:** `plugins/framework/plugins/cli/bin/commands/regen-generated.ts` (new)

Calls all non-migration codegen in build order:
1. `generateBarrelStubs({ root })`
2. `generatePluginRegistry({ root })`
3. `generatePluginDocs({ root })`
4. `generateConfigOrigins({ root })`

All four imported from `@plugins/framework/plugins/tooling/plugins/codegen/core`. Subsumes what `regen-docs` did.

**Register in:** `plugins/framework/plugins/cli/bin/index.ts` — replace `registerRegenDocs` with `registerRegenGenerated`.

### 7. Delete `regen-docs.ts` CLI subcommand

**File:** `plugins/framework/plugins/cli/bin/commands/regen-docs.ts` (delete)

Fully subsumed by `regen-generated`. Remove import and registration from `index.ts`.

### 8. Update `postRebaseNormalize` in push.ts

**File:** `plugins/framework/plugins/cli/bin/commands/push.ts`

Replace `docs` marker with `generated` marker:

- `docsMarker` → `generatedMarker` (marker path: `"generated"` instead of `"docs"`)
- `ranDocs` → `ranGenerated`
- Call `regen-generated` instead of `regen-docs`
- CLAUDE.md prose conflict scan stays unchanged (still needed after `regen-claudemd` 3-way merge)

### What does NOT change

- `regen-migrations.sh` / `regen-migrations` CLI — stays as-is with its own `migrations` marker
- `regen-claudemd.sh` behavior — still does 3-way merge for prose; only marker name changes
- Stale `docs` markers from prior failed pushes — already cleaned up by the `rmSync(markerDir, { recursive: true })` at push start

## Verification

1. `./equin build` — registers the new driver in git config
2. `git config --local --get-regexp 'merge\.regen'` — should show 3 drivers (`regen-generated`, `regen-claudemd`, `regen-migrations`)
3. `bun plugins/framework/plugins/cli/bin/index.ts regen-generated` — should complete idempotently
4. Conflict simulation: two branches adding different plugins, push one — should auto-resolve `web.generated.ts` etc.
5. `./equin check` — `plugins-registry-in-sync`, `barrel-stubs-in-sync`, `plugins-doc-in-sync` must pass
