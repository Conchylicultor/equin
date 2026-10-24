# Harden config_v2 `tiers`, `conflicts` (and `scope-forked`) resource loaders against the boot-registry race

## Context

`config_v2` exposes server live-state **resources** that the Settings/Config UI
subscribes to: `config-v2.values`, `config-v2.tiers`, `config-v2.conflicts`, and
`config-v2.scope-forked`. The server framework starts serving WS/HTTP resource
subscriptions **before** `onReady → initRegistry()` runs. `initRegistry()` is what
populates the module-level `descriptorByPath` map and installs `configGetter` /
`scopeForkedChecker`. So a client that subscribes during the boot window (Settings
pane open across a `./equin build` restart, or a cold reload on a pane chain
that includes the config-detail pane) hits loaders whose backing state is still empty.

The `values` loader was already hardened: it `await`s a module-level `registryReady`
deferred promise (resolved by `markRegistryReady()`, called from `initRegistry`'s
`finally`) before reading `descriptorByPath`, and throws loudly on a still-missing
descriptor afterward. Its three siblings were **not** hardened and share the exact
same bug class:

- `computeTiers` returns `{}` when `descriptorByPath.get(path)` is missing → Settings
  silently renders every field as the **"default"** tier (no git/user badges).
- `computeAllConflicts` iterates an empty `descriptorByPath` and returns `{}` → real
  on-disk config **conflict banners are hidden**, so the user is never prompted to
  reconcile an actual conflict.
- `scope-forked`'s loader returns `{ forked: false }` while `scopeForkedChecker` is
  null → a genuinely-forked scope is reported as un-forked during the window.

All three resolve synchronously without awaiting readiness and are only re-notified
on a later config-file write or pane remount — so the wrong state persists silently.
No crash; stale/wrong state. This is the same structural bug as the values fix.

**Outcome:** make all four config_v2 resource loaders gate on registry readiness via
one named primitive, so this bug class can't recur per-resource.

## Approach

Single file changes, all in
`plugins/config_v2/server/internal/resource.ts`.

### 1. Add a `whenRegistryReady` loader wrapper

Today the gate is an inline `await registryReady` baked into the `values` loader.
Promote it to a small reusable wrapper so every registry-dependent resource shares
one self-documenting primitive (fixes the structural issue, not just two instances):

```ts
// Wraps a loader so it resolves only after initRegistry has populated the
// registry (descriptorByPath / configGetter / scopeForkedChecker). Pre-readiness
// the server already serves subscriptions, so without this gate a loader answers
// from empty state — emitting an incomplete/wrong resource the client caches.
function whenRegistryReady<A, R>(fn: (arg: A) => R | Promise<R>): (arg: A) => Promise<R> {
  return async (arg: A) => {
    await registryReady;
    return fn(arg);
  };
}
```

Keep the existing `registryReady` promise + `markRegistryReady()` exactly as-is
(lines 21–33). No changes to `initRegistry` / `markRegistryReady` wiring.

### 2. Apply the wrapper to all four loaders

- **`values`** (line 39): wrap its existing async body — `loader: whenRegistryReady(async ({ path, scopeId }) => { ... })` — and drop the now-redundant inline `await registryReady` (line 40). Behavior identical; this keeps the gate single-sourced rather than leaving one loader on the old inline form.
- **`tiers`** (line 194): `loader: whenRegistryReady(({ path, scopeId }) => computeTiers(path, scopeId))`.
- **`conflicts`** (line 90): `loader: whenRegistryReady(() => computeAllConflicts())`.
- **`scope-forked`** (line 133): `loader: whenRegistryReady(({ scopeId }) => ({ forked: scopeForkedChecker ? scopeForkedChecker(scopeId) : false }))`. After readiness `scopeForkedChecker` is always installed, so the ternary's `false` branch becomes unreachable in practice; left in place as a harmless guard.

### 3. Make `computeTiers` fail loudly on a post-readiness miss

Mirror the `values` loader's fail-loud contract. Replace `computeTiers`'s
`if (!descriptor) return {};` (line 145) with a throw using the same message
shape as the values loader (resource.ts:45):

```ts
const descriptor = descriptorByPath.get(path);
if (!descriptor) {
  // After readiness, an unregistered path is a genuine bug (unknown descriptor)
  // — fail loudly rather than emit empty tiers that render every field as "default".
  throw new Error(`[config-v2] no descriptor registered for tiers path "${path}"`);
}
```

`computeAllConflicts` needs **no** miss-handling change: it has no single `path`
key, and after readiness an empty `descriptorByPath` legitimately means "no
descriptors → no conflicts." The gate alone is the fix there.

## Why this is safe

- `computeTiers` and `computeAllConflicts` are module-private and called **only**
  from their respective loaders, so changing their sync→async/throw behavior has no
  other call sites.
- Loaders returning promises is already the framework contract (the `values` loader
  is async). The notify/watch path (`notifyTiers`, `configV2ConflictsServerResource.notify()`,
  `notifyValues` in `registry.ts` `buildEntry`) is unchanged — it re-triggers the
  loaders, which now correctly await readiness on the first boot-window call and
  return real data on every subsequent notify.

## Files

- `plugins/config_v2/server/internal/resource.ts` — add `whenRegistryReady`; wrap
  all four loaders; make `computeTiers` throw on miss. (Only file touched.)

## Verification

1. `./equin build` from the worktree; confirm a clean boot (the doc/migration
   checks and server start succeed).
2. **Boot-window repro (the core fix):** open the Settings/Config pane in the app at
   `http://<worktree>.localhost:9000`, navigate to a config with a known git-tier or
   user-tier field, then run `./equin build` again while that pane stays open
   (forces a server restart → fresh subscription during the boot window). After
   reconnect the field tier badges (git/user) must render correctly — not all
   "default". Before this fix they'd silently collapse to "default" until the next
   config write.
3. **Conflict banner repro:** create a real on-disk conflict (an override `.jsonc`
   whose `// @hash` is stale vs its `.origin.jsonc`), then trigger a restart while the
   config pane is open. The conflict banner must appear on reconnect (previously
   hidden because `computeAllConflicts` returned `{}` during the window).
4. **Fail-loud check:** subscribing to `config-v2.tiers` with an unregistered path
   after readiness should now surface the thrown `[config-v2] no descriptor
   registered for tiers path "..."` error rather than silently empty tiers.
5. Scripted check with `e2e/screenshot.mjs` against the config pane URL to capture
   before/after badge + banner state across a restart if a static check is wanted.
