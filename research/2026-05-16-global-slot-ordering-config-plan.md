# Slot Ordering Config — Implementation Plan

## Context

Slot contributions are registered by independent plugins with no canonical ordering. Today the `reorder` plugin stores user-customized order in a Postgres table (`reorder_prefs`) with fractional ranks, but there is no developer-defined default order — it's implicit registration order. In a marketplace model, slot definers can't know about contributors, and contributors shouldn't coordinate with each other. Yet there must be a deterministic, intentional order.

This plan implements the two-layer file-based ordering system described in `research/2026-05-16-slot-ordering-config.md`: a committed **code config** (developer-defined canonical order, enforced by agents) and a per-machine **user config** (`~/.singularity/slots/`, edited via UI drag-and-drop).

## Design Decisions

| Question | Decision |
|----------|----------|
| Code config location | Colocated with the slot-defining plugin: `plugins/<path>/slot-order.jsonc` |
| Naming when plugin owns multiple slots | `slot-order.<memberName>.jsonc` (e.g. `slot-order.section.jsonc`) |
| Config key format | `pluginId:contributionId` (matches `entryKey()` in `sorting.ts`) |
| Server API for user writes | Extend existing `PATCH /api/reorder/:slotId` to side-write user config |
| Conditional contributions (`excludeFromReorder`) | Excluded from config — only statically discoverable, non-excluded contributions appear |
| Groups | Stay DB-stored (dynamic user structure layers on top of file-based base order) |
| Hidden/spacers | Stay DB-stored (dynamic user decisions, not ordering preferences) |
| JSONC parser | `jsonc-parser` package (already used by TS ecosystem for tsconfig handling) |

## Implementation Streams

### Stream 1: Codegen — `generateSlotOrderConfigs()`

**New file: `tooling/src/slot-order-gen.ts`**

Reuses the existing `enrichPluginTreeDocs()` pass which already:
- Imports all web barrels and calls `collectSlotDisplayNames(mod)` per node
- Extracts `runtimeContributions` with `{ slotId, doc: { label } }` per node

The codegen needs two maps:
1. **`slotId → ownerNodeDir`** — built during the `collectSlotDisplayNames` loop by tracking which node's barrel defined each slot
2. **`slotId → contributionKey[]`** — built from `runtimeContributions` across all nodes: `key = node.name + ":" + contribution.doc.label`

Algorithm:
1. Run enrichment (or reuse its output — call after `generatePluginDocs` which already runs it)
2. For each slot with an owner, read existing `slot-order.jsonc` (if any)
3. Compute `codeKeys` = all discovered contribution keys for this slot
4. Compute `configKeys` = set of keys in existing `order` + `unsorted`
5. New keys (`codeKeys - configKeys`) → append to `unsorted`
6. Stale keys (`configKeys - codeKeys`) → remove from both arrays
7. Write JSONC file (only if content changed)

**Wire into build**: Add call in `cli/src/commands/build.ts` after `generatePluginDocs()` (step 4) and before `runChecks()`. The enrichment data is already computed by docgen — export it for reuse.

```
// In build.ts, after generatePluginDocs():
await generateSlotOrderConfigs({ root });
```

### Stream 2: Check — `reorder:slot-order-unsorted-empty`

**New file: `plugins/reorder/check/index.ts`**

A plugin-contributed check (discovered by `loadPluginChecks()` at runtime). Two checks:

1. **`reorder:configs-in-sync`** — re-renders expected JSONC for each slot, diffs against committed files. Fails if any file is missing or stale. Hint: "Run `./equin build` and commit the regenerated files."

2. **`reorder:unsorted-empty`** — reads every committed `slot-order*.jsonc` file and fails if any has a non-empty `unsorted` array. Hint: "Move entries from `unsorted` into `order` at the correct position."

Pattern to follow: `plugins/welcome/check/index.ts` (existing example).

### Stream 3: Server Startup Reconciliation

**New file: `plugins/reorder/server/internal/slot-order-reconcile.ts`**

Called from `onReady` in the reorder server plugin. For every code config found:

1. If no user config at `~/.singularity/slots/<slotId>.jsonc` → copy code config's `order` array
2. If user config exists and `Set(code.order) == Set(user.order)` → leave alone (user reordered)
3. If user config exists and sets differ → overwrite with code config (contributions changed)

User config only stores `{ "slot": "...", "order": [...] }` — no `unsorted` field.

### Stream 4: Resource Loader — Read from Files

**Modify: `plugins/reorder/server/internal/resource.ts`**

The resource loader changes from pure-DB to file-primary:

```typescript
loader: async ({ slotId }) => {
  // 1. Read user config order (fall back to code config)
  const order = readUserSlotOrder(slotId) ?? readCodeSlotOrder(slotId);
  
  // 2. Convert ordered array → rankMap with synthetic fractional ranks
  const out: ReorderSlotPrefs = {};
  if (order) {
    let prev: Rank | null = null;
    for (const key of order) {
      prev = Rank.between(prev, null);
      out[key] = { rank: prev };
    }
  }
  
  // 3. Merge DB rows for hidden flags and spacers only
  const dbRows = await db.select(...).from(_reorderPrefs).where(...);
  for (const r of dbRows) {
    if (r.hidden) {
      out[r.contributionId] = { ...out[r.contributionId], hidden: true };
    }
    if (isSpacer(r.contributionId)) {
      out[r.contributionId] = { rank: r.rank, hidden: r.hidden };
    }
  }
  
  return out;
}
```

The wire format (`ReorderSlotPrefs`) stays identical — clients see no change.

### Stream 5: Write Path — Side-Write User Config on DnD

**Modify: `plugins/reorder/server/internal/handlers.ts`**

After the existing DB upsert in `handlePatchSlot`, rebuild the full order and write user config:

```typescript
// After DB write succeeds:
const allRows = await db.select(...).from(_reorderPrefs).where(eq(slotId)).orderBy(rank);
const orderedKeys = allRows.filter(r => !isSpacer(r)).map(r => r.contributionId);
await writeUserSlotOrder(slotId, orderedKeys);
```

**New helper file: `plugins/reorder/server/internal/slot-order-io.ts`**

Shared read/write utilities:
- `readUserSlotOrder(slotId): string[] | null`
- `readCodeSlotOrder(slotId): string[] | null`
- `writeUserSlotOrder(slotId, order: string[]): void` — atomic write (tmp + rename)
- `slotIdToFilename(slotId): string` — maps `task-detail.section` → `task-detail.section.jsonc`

User config path: `join(SINGULARITY_DIR, "slots", filename)`
Code config path: discovered by globbing `plugins/**/slot-order*.jsonc` (cached at startup)

### Stream 6: One-Time DB Migration

**New file: `plugins/reorder/server/internal/slot-order-migrate.ts`**

Runs in `onReady` before reconciliation. Sentinel: `~/.singularity/slots/.migrated-from-db`.

1. If sentinel exists → skip
2. Read all distinct `slotId` values from `reorder_prefs`
3. For each: query rows ordered by rank, extract non-spacer contribution keys in order
4. Write `~/.singularity/slots/<slotId>.jsonc`
5. Write sentinel

This preserves existing user customizations across the transition.

## File Changeset

### New Files

| File | Purpose |
|------|---------|
| `tooling/src/slot-order-gen.ts` | Codegen: scan contributions, emit/update JSONC configs |
| `plugins/reorder/check/index.ts` | Two checks: configs-in-sync + unsorted-empty |
| `plugins/reorder/server/internal/slot-order-io.ts` | Shared file read/write utilities for user + code configs |
| `plugins/reorder/server/internal/slot-order-reconcile.ts` | Startup reconciliation |
| `plugins/reorder/server/internal/slot-order-migrate.ts` | One-time DB → file migration |
| `plugins/**/slot-order.jsonc` (generated) | Code config files per render slot |

### Modified Files

| File | Change |
|------|--------|
| `cli/src/commands/build.ts` | Add `generateSlotOrderConfigs()` call after docgen |
| `tooling/src/docgen.ts` | Export enrichment data (slot→owner map) for reuse by slot-order-gen |
| `plugins/reorder/server/index.ts` | Add `onReady` calling migrate → reconcile; no new routes needed |
| `plugins/reorder/server/internal/resource.ts` | Change loader to read from files for base order |
| `plugins/reorder/server/internal/handlers.ts` | Side-write user config after DB rank upsert |
| `package.json` (root) | Add `jsonc-parser` dependency |

## Data Flow

```
BUILD TIME:
  enrichPluginTreeDocs() → slotId→ownerDir + slotId→contributionKey[]
    → for each slot: diff vs existing JSONC → append new to unsorted, remove stale
    → write JSONC file at slot owner plugin dir

CHECK TIME:
  reorder:configs-in-sync → re-render expected → diff vs committed → fail if stale
  reorder:unsorted-empty → read all slot-order*.jsonc → fail if unsorted non-empty

SERVER STARTUP (onReady):
  migrateReorderPrefsToFiles() → one-time: DB ranks → user config files + sentinel
  reconcileSlotOrderConfigs() → seed/reset user configs from code configs

RENDER TIME (resource loader):
  read user config → synthesize ranks → merge DB hidden/spacers → return ReorderSlotPrefs
  (client code unchanged — same wire format)

DRAG-AND-DROP (write path):
  existing DB upsert → rebuild order from DB → write user config → notify resource
```

## Sequencing

1. **Add `jsonc-parser`** + create `slot-order-io.ts` (shared utilities)
2. **Codegen** (`slot-order-gen.ts`) + wire into `build.ts` — generates first config files
3. **Check** (`plugins/reorder/check/index.ts`) — enforces `unsorted` empty
4. **Reconcile + Migrate** (server internals) — startup file seeding
5. **Resource loader** change — read from files
6. **Handler extension** — side-write user config on DnD
7. **Initial sorting** — manually place all `unsorted` entries into `order` for existing slots

Steps 1-3 can be done independently from 4-6. Step 7 is a one-time manual step after first build.

## Verification

1. Run `./equin build` — should generate `slot-order.jsonc` files with all contributions in `unsorted`
2. Run `./equin check` — should fail on `reorder:unsorted-empty`
3. Manually sort entries into `order` in each config file
4. Run `./equin check` again — should pass
5. Restart server — should see user config files created at `~/.singularity/slots/`
6. Open app, reorder items via DnD — should persist to user config files
7. Delete user config, restart — should re-seed from code config
8. Add a new contribution to a slot, run build — should appear in `unsorted`
