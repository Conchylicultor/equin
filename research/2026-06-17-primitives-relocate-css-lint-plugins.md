# Relocate Lint-Only CSS Primitives Under the Existing `css/` Umbrella

**Date:** 2026-06-17  
**Category:** primitives

---

## Context

`plugins/primitives/plugins/` currently has 83 sub-plugins in a flat list. Four of them — `radius`, `z-layers`, `control-size`, `icon-auto` — are **lint-only** plugins: no `web/` or `server/` barrel, just `lint/index.ts` + a rule file. All four enforce CSS-design-system constraints (corner radii, z-indices, control heights, slot-icon sizes).

An **existing `css/` umbrella** already lives at `plugins/primitives/plugins/css/` with 5 layout-primitive sub-plugins (`center`, `cluster`, `frame`, `grid`, `overlay`). These 4 lint-only plugins are thematically CSS/design-system enforcement, making the `css/` umbrella the right home.

This move: (a) reduces flat clutter in `primitives/plugins/`; (b) co-locates all CSS-enforcement work in one directory; (c) is near-free because no other plugin imports these (they have no barrels) and discovery is filesystem-based.

---

## What Changes

### Files to move (directory `mv`)

| From | To |
|---|---|
| `plugins/primitives/plugins/radius/` | `plugins/primitives/plugins/css/plugins/radius/` |
| `plugins/primitives/plugins/z-layers/` | `plugins/primitives/plugins/css/plugins/z-layers/` |
| `plugins/primitives/plugins/control-size/` | `plugins/primitives/plugins/css/plugins/control-size/` |
| `plugins/primitives/plugins/icon-auto/` | `plugins/primitives/plugins/css/plugins/icon-auto/` |

The `css/plugins/` directory already exists (it hosts `center`, `cluster`, `frame`, `grid`, `overlay`).

### `package.json` `name` field updates (convention: name mirrors filesystem path)

| Plugin | Old name | New name |
|---|---|---|
| `radius` | `@singularity/plugin-primitives-radius` | `@singularity/plugin-primitives-css-radius` |
| `z-layers` | `@singularity/plugin-primitives-z-layers` | `@singularity/plugin-primitives-css-z-layers` |
| `control-size` | `@singularity/plugin-primitives-control-size` | `@singularity/plugin-primitives-css-control-size` |
| `icon-auto` | `@singularity/plugin-primitives-icon-auto` | `@singularity/plugin-primitives-css-icon-auto` |

### Nothing else changes

- **No cross-plugin imports to update** — these plugins have no `web/` or `server/` barrel, so no `@plugins/…` import paths reference them anywhere.
- **ESLint rule namespaces are unchanged** — the `name` field inside each plugin's `lint/index.ts` is an authored string (`"radius"`, `"z-layers"`, etc.), not path-derived. Rules stay named `radius/no-adhoc-radius`, `z-layers/no-adhoc-zindex`, etc.
- **No web/server registry entries** — these plugins never appear in `web.generated.ts` or `server.generated.ts` (no barrels). Only `lint.generated.ts` is affected.
- **No changes to `css/` umbrella** — the umbrella's `lint/index.ts` (which owns `no-adhoc-layout`) does not need updating; sub-plugins contribute lint rules independently via their own `lint/index.ts` files, discovered by filesystem glob.
- **No manual registry edits** — `./equin build` regenerates `lint.generated.ts` and all CLAUDE.md AUTOGEN blocks from the filesystem.

---

## Implementation Steps

1. **Move the four plugin directories** into `plugins/primitives/plugins/css/plugins/`:
   ```bash
   mv plugins/primitives/plugins/radius    plugins/primitives/plugins/css/plugins/
   mv plugins/primitives/plugins/z-layers  plugins/primitives/plugins/css/plugins/
   mv plugins/primitives/plugins/control-size plugins/primitives/plugins/css/plugins/
   mv plugins/primitives/plugins/icon-auto plugins/primitives/plugins/css/plugins/
   ```

2. **Update `package.json` `name` field** in each of the 4 moved plugins (Edit tool on each file).

3. **Run `./equin build`** — this regenerates:
   - `lint.generated.ts` (entries update from `primitives/plugins/{name}` → `primitives/plugins/css/plugins/{name}`)
   - `docs/plugins-compact.md`, `docs/plugins-details.md`
   - Each plugin's `CLAUDE.md` AUTOGEN block
   - (Note: `bun install` is also run as the first step, which picks up the package name changes.)

4. **Run `./equin check`** and verify these pass:
   - `plugins-registry-in-sync`
   - `plugins-doc-in-sync`
   - `eslint` (lint rules still fire correctly at their new path)
   - `type-check`

---

## What Is NOT Changed

- The `name` field inside `lint/index.ts` (the ESLint plugin name, e.g. `"radius"`) — unchanged to keep ESLint rule IDs stable for any existing suppression comments.
- `plugins/primitives/plugins/css/lint/index.ts` — the `no-adhoc-layout` rule is unchanged.
- No other plugin's source files — no imports to repair.

---

## Verification

```bash
# After move + package.json edits:
./equin build

# Confirm checks pass:
./equin check plugins-registry-in-sync
./equin check plugins-doc-in-sync
./equin check eslint
./equin check type-check

# Spot-check that rules still fire (a file with 'rounded' class should lint-error):
# (manual or in a test file)
```

The moved plugins should appear under the `css` umbrella in the Studio plugin explorer at the deployed URL.
