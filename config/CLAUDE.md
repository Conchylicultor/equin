# config/

Git-committed config defaults and overrides. Structure mirrors `~/.equin/state/config/` by plugin hierarchy.

## File layout

```
config/<plugin-tree>/
  <name>.origin.jsonc          # Auto-generated from defineConfig defaults — DO NOT edit
  <name>.jsonc                 # Agent overrides (optional, hand-edited, committed)
  @app/<id>/<name>.jsonc       # Per-app override (optional) — applies only to app <id>
```

Every file starts with `// @hash <12-hex>` on line 1.

## How to override defaults

1. Run `./equin build` to generate/update `.origin.jsonc` files
2. Copy `<name>.origin.jsonc` → `<name>.jsonc`
3. Edit values in the copy. Keep the `// @hash` line — it must match the origin's hash.
4. Commit both files.

## How to override defaults for a specific app

Customize app `<id>` (e.g. `agent-manager`) for a descriptor:

1. Create `config/<plugin-tree>/@app/<id>/<name>.jsonc`.
2. Put **only the fields that differ** for that app (a partial delta — the rest inherit the base value).
3. Line 1: `// @hash <hash>` copied from the **base** origin `config/<plugin-tree>/<name>.origin.jsonc`. A scoped override anchors to the base origin; **never** add a scoped `.origin.jsonc`.
4. `./equin build` propagates it (resolved as `base ⊕ delta`). Commit the `@app/<id>/<name>.jsonc`.

See `plugins/config_v2/CLAUDE.md` → "App scopes" for resolution semantics and how consumers read scoped values.

## When a descriptor is removed

If a `defineConfig` descriptor is deleted, its files here become orphaned (no live default backs them). `./equin build` prunes them automatically — the orphaned `.origin.jsonc`, its `.jsonc` override, and any `@app/<id>/<name>.jsonc` scoped deltas — and removes the now-empty directories. Just commit the deletions. The `config-origins-in-sync` check remains a guard for orphans committed without a build.

## When origin changes

If `defineConfig` defaults change, build regenerates `.origin.jsonc` with a new hash. The `config-origins-in-sync` check fails until you update the `// @hash` in your `.jsonc` override to match. Review the new origin, reconcile your overrides, update the hash.

## What happens downstream

On server start, `propagate()` copies the resolved config here (override if present, else origin) to `~/.equin/state/config/` where users can further override via the UI. See `plugins/config_v2/CLAUDE.md` for the full three-layer model.
