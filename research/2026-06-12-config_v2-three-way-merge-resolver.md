# config_v2: three-way merge resolver

## Context

When upstream config defaults move underneath a user override, config_v2 detects a
**hash conflict** (the override's `// @hash` header no longer matches its origin).
Today reconciliation is binary and lossy:

- **Keep my values** (`acknowledgeConflict`) — bump the override hash so the whole
  override wins again, discarding every upstream change.
- **Accept new defaults** (`deleteOverride`) — delete the override, discarding every
  user customization.

Neither merges. A user who changed field `A` loses the upstream's new value for an
untouched field `B` (Keep), or loses their own `A` (Accept). This adds a **Merge**
resolver that does a per-field three-way merge: untouched-by-user fields take the new
upstream value, untouched-by-upstream fields keep the user's value, and only fields
**both** sides changed differently are flagged as true conflicts for manual attention.

A real three-way merge needs the **base** (the origin the override was written
against). Today only its *hash* is stored, and the user-layer origin lives in
`~/.singularity/config/` (not git), so the old content is unrecoverable. We therefore
**snapshot the base at propagate-time**: when `./equin build` is about to
overwrite a user origin that a still-in-sync override depends on, it writes the old
origin content to a sibling `<name>.ancestor.jsonc` first. The merge is available for
any conflict created after this ships; pre-existing conflicts (no snapshot) gracefully
fall back to the existing binary buttons.

## Design (approved)

- **Base source:** snapshot at propagate-time → `<name>.ancestor.jsonc` (user layer).
- **Merge behavior:** per-field auto-merge; flag divergent fields as true conflicts.
- **New UI:** a **Merge** button alongside *Keep my values* / *Accept new defaults*,
  shown only when an ancestor snapshot exists.

### Ancestor lifecycle (the load-bearing invariant)

Capture inside `propagate()` **before** the origin overwrite, iff:

```
ow && ow.hash !== null && oldOrigin && oldOrigin.hash === ow.hash && ow.hash !== newHash
```

i.e. the override is currently *in sync* with the origin, but the incoming upstream
will make it stale — the exact transition moment. This is naturally idempotent across
repeated builds (on a later build `oldOrigin.hash !== ow.hash`, so the real base is
never clobbered) and across reconcile-then-new-conflict (a fresh base is captured once
the override is back in sync). The ancestor is deleted on every terminal resolution
(merge-to-clean / acknowledge / delete-override) and self-corrected on any
no-conflict build, so it never litters.

## Implementation

Ordered by dependency. Critical files:

- `plugins/config_v2/core/internal/tier-logic.ts`
- `plugins/framework/plugins/tooling/plugins/codegen/core/config-origin-gen.ts`
- `plugins/config_v2/core/internal/resource.ts` (schema)
- `plugins/config_v2/server/internal/resource.ts` (`computeAllConflicts`)
- `plugins/config_v2/server/internal/registry.ts`
- `plugins/config_v2/plugins/settings/core/internal/endpoints.ts` + `server/internal/handlers.ts` + `server/index.ts`
- `plugins/config_v2/plugins/settings/web/components/config-detail.tsx` + `config-field-row.tsx`

### 1. `tier-logic.ts` — pure logic

Add `threeWayMerge(base, ours, theirs): { merged, conflicts }`. Per key over the union
of keys: `oursChanged = !eq(o,b)`, `theirsChanged = !eq(t,b)` (`eq` = `JSON.stringify`
equality, matching existing precedent in `config-field-row`/`isSoftConflict`):

- `!oursChanged` → `merged[key] = theirs`
- else `!theirsChanged` → `merged[key] = ours`
- else `eq(ours, theirs)` → `merged[key] = ours` (both made the same change)
- else → `merged[key] = ours` **and** push `key` to `conflicts` (true conflict)

Extend `propagate` with an optional 4th param `ancestor?: ConfigProxy`. Read
`oldOrigin` and `ow` at the **top**, before the existing `downstreamOrigin.write`.
When the capture predicate (above) holds, `ancestor.write(oldOrigin.content,
oldOrigin.hash)` before the write. Conflict return value unchanged (recomputed from
`ow.hash !== newHash`). Export `threeWayMerge` from `core/index.ts`.

### 2. `config-origin-gen.ts` — caller wiring + orphan cleanup

In `propagateConfigToUser`, build `userAncestor = fileConfigProxy(<name>.ancestor.jsonc)`
sibling and pass as the 4th arg. After propagate: `if (!conflict && existsSync(ancestorPath)) unlinkSync(ancestorPath)`
(self-correcting cleanup of a dangling ancestor; both fns already imported here).

### 3. `core/internal/resource.ts` — schema

Add `trueConflictKeys: z.array(z.string()).optional()` to `configV2ConflictEntrySchema`.
Presence ⇒ ancestor available ⇒ Merge offered; `[]` ⇒ clean auto-merge; non-empty ⇒
those fields are true conflicts. Absent ⇒ legacy/binary path.

### 4. `server/internal/resource.ts` — `computeAllConflicts`

In the `hasConflict` (kind `"hash"`) branch, read `<name>.ancestor.jsonc` via
`jsoncConfigProxy`. If it exists, compute `threeWayMerge(base, overrideValues,
originValues).conflicts` and attach as `trueConflictKeys`. **Wrap the ancestor read in
try/catch** — a malformed/half-written ancestor must fall back to the binary UI, not
throw and take down the whole conflicts resource.

### 5. `server/internal/registry.ts`

- Add `userAncestorPath` to `CacheEntry`; derive it in `buildEntry` next to the
  origin/overwrites paths.
- New `mergeConflictByPath(storePath, scopeId?): { resolved, conflictKeys }` — read
  ancestor/override/origin (throw if no ancestor); `threeWayMerge`; write `merged`
  (through `injectCollectionIds`) as the override with hash =
  `conflicts.length === 0 ? computeHash(origin.content) : ow.hash` (keep the stale hash
  on partial merge — proven idempotent: re-running yields the same `trueConflictKeys`).
  When fully resolved, `unlinkSync` the ancestor. Return `{ resolved, conflictKeys }`.
- Add ancestor `unlinkSync` (guarded by `existsSync`) to `acknowledgeConflictByPath`
  and `deleteOverrideByPath`.
- Export `mergeConflictByPath` from `server/index.ts`.

No new file watcher: the merge writes the watched `userOverwritesPath`, and the
build-time origin write triggers the existing `onFileChange` → `configV2ConflictsServerResource.notify()`.

### 6. Endpoint

`mergeConflict` = `POST /api/config-v2/merge-conflict`, body `{ storePath, scopeId? }`,
response `{ resolved: boolean, conflictKeys: string[] }`. Add to `settings/core/internal/endpoints.ts`
+ barrel `core/index.ts`. Handler `handleMergeConflict` in `server/internal/handlers.ts`
(mirror `handleDeleteOverride`, wrap errors in `HttpError(400, ...)`). Register in
`server/index.ts` httpRoutes.

### 7. UI

**`config-detail.tsx`** (Branch C — hard hash conflict banner): add
`const { mutate: merge } = useEndpointMutation(mergeConflict)` + `handleMerge`. Render a
**Merge** button (next to Accept/Keep) only when `conflictEntry.trueConflictKeys !== undefined`.
Optionally show counts ("N auto-merge · M need attention"). Pass
`trueConflictKeys={conflictEntry?.trueConflictKeys}` into each `<ConfigFieldRow>`.

**`config-field-row.tsx`**: add prop `trueConflictKeys?: string[]`. Change the
`hasConflict` computation: when `trueConflictKeys` is defined, `hasConflict =
trueConflictKeys.includes(fieldKey)`; otherwise keep the existing
`originValue !== undefined && JSON.stringify(value) !== JSON.stringify(originValue)`
fallback. **Required for partial-merge correctness** — after a partial merge the
override holds auto-resolved values, so the naive value-vs-origin check would
false-flag intentionally-kept user fields.

> Per-field **Accept** stays a value edit (keeps the stale hash), not a resolution.
> After resolving the last divergent field, the user clicks **Merge** again → zero
> conflicts → hash bumped + ancestor deleted. The Merge button is the resolution path.

### 8. Tests (this subsystem has zero coverage today)

Add `bun:test` units for the pure load-bearing logic:

- `threeWayMerge` — the 3-field example (user-only / origin-only / divergent →
  `conflicts === ["c"]`), plus key-only-in-ours, key-only-in-theirs, both-same-change.
- `propagate` ancestor-capture predicate across: first conflict, repeated builds
  (no clobber), reconcile-then-new-conflict, soft conflict, upstream-moves-twice.

## Verification

1. `./equin build` (regenerates origins, propagates, restarts server).
2. Reproduce a conflict end-to-end:
   - Open a config in Settings, edit one field (writes a user override against the
     current origin).
   - Edit that plugin's `defineConfig` defaults so a *different* field's default
     changes, `./equin build` again → propagate detects the stale override,
     writes `<name>.ancestor.jsonc`, surfaces a hash conflict.
   - Inspect: `query_db` is irrelevant here (file-based); instead check
     `~/.singularity/config/<worktree>/<tree>/<name>.ancestor.jsonc` exists and carries
     a `// @hash` matching the override's header.
3. In Settings, confirm the **Merge** button appears. Click it:
   - No true conflict → banner clears, override now holds the merged doc, ancestor file
     gone, app resolves to merged values.
   - Divergent field present → only that field is flagged (warning strip via
     `trueConflictKeys`); resolve it, click Merge again → fully resolved.
4. Drive it with `e2e/screenshot.mjs --url http://<worktree>.localhost:9000/... --click "Merge"`
   to capture before/after and confirm button state.
5. Regression: pre-existing conflict with **no** ancestor → Merge button hidden,
   Keep/Accept still work. `./equin check config-origins-in-sync` still passes
   (it scans git `config/`, never the user dir; `.ancestor.jsonc` is invisible to it).
6. Run the new units: `bun test plugins/config_v2/core/internal/tier-logic.test.ts`.
