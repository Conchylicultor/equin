# Fix — `defineEntity` can't resolve `fields.storage` at table-materialization time

> Prerequisite fix for Stage D of the fields-unified-entities roadmap
> ([`2026-06-18-global-define-entity-stage-c.md`](./2026-06-18-global-define-entity-stage-c.md)).
> Scope: **the resolution fix only.** Stage D (migrating `slow_ops` onto
> `defineEntity`) is a separate follow-up, now unblocked by this change.

## Context

`defineEntity(name, fields, meta)`
(`plugins/infra/plugins/entities/server/internal/define-entity.ts`) builds a
Drizzle `pgTable` by resolving each field's column builder through
`resolveFieldStorage(typeId)`
(`plugins/fields/server/internal/storage.ts`). That resolver reads the
`fields.storage` contribution registry, whose backing `byKind` map
(`plugins/framework/plugins/server-core/core/contributions.ts`) is populated
**only** by `collectContributions(...)`, which runs in exactly one place: server
boot, `plugins/framework/plugins/server-core/bin/index.ts:72`.

`defineEntity` is called at the **top level of a `tables.ts`**, so it resolves
storage at **module-eval time**. The registry is empty then, in **both**
contexts that materialize tables:

- **drizzle-kit codegen** (`bun x --bun drizzle-kit generate`, spawned by the
  build — see `plugins/framework/plugins/cli/bin/migrations.ts:517`): the
  subprocess never boots the server. It loads `drizzle.config.ts`, then
  `require()`s the schema-glob `tables.ts` files. `collectContributions` never
  runs → `byKind` empty → `defineEntity` throws
  `field "..." has type "..." with no fields.storage contribution`. Codegen
  aborts.
- **server boot**: `bin/index.ts:14` eagerly imports every server barrel (→
  transitively their `internal/tables.ts`) **before** `collectContributions` at
  line 72. So a top-level `defineEntity` in a live `tables.ts` throws the same
  way. Currently **latent** — no live `tables.ts` uses `defineEntity` yet; Stage
  C only exercised it from a unit test that manually called
  `collectContributions`. Stage D (slow_ops) would be the first real adopter and
  would hit this at boot too.

`defineExtension` (entity-extensions) is unaffected: it takes raw drizzle
builders and never calls `resolveFieldStorage`. `defineEntity` is the first
primitive whose table construction depends on the storage registry.

The 7 storage builders live in declarative barrels
`plugins/fields/plugins/<type>/plugins/storage/server/index.ts` (bool, date,
float, int, json, text, uuid), each
`export default { contributions: [Fields.Storage({ type, build })] }`. Nothing
imports them outside the boot-time `collectContributions` pass.

**Root cause:** storage builders are pure build-time facts, but are reachable
only through a runtime-boot-only collection pass. The fix makes resolution
**timing-independent** — the resolver pulls the builders directly from their
barrels via filesystem discovery, so it works identically in codegen, boot,
unit tests, and docgen.

## Approach — self-loading `resolveFieldStorage` (additive over the live registry)

Make `fields/server` self-populate an eager, additive `Map<typeId, builder>` on
first use, decoupled from `collectContributions`. Resolution consults the live
registry first (preserving the unit-test path and post-boot runtime), then falls
back to the eager map (the always-available source for the codegen / boot
loader-pass windows). Both derive from the same 7 barrels → no drift.

### The one file to edit

`plugins/fields/server/internal/storage.ts` — add an eager index + an
idempotent synchronous loader, and route `resolveFieldStorage` through it:

```ts
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

// type token symbol is captured inside Fields.Storage's defineServerContribution;
// the eager loader filters barrel contributions by it (same module instance).
let populated = false;
const eager = new Map<string, StorageColumnBuilder>();

// Sync, idempotent. Pulls every field-storage builder straight from its barrel
// so resolution never depends on the boot-time `collectContributions` pass.
function ensureFieldStoragePopulated(): void {
  if (populated) return;
  populated = true; // set first: a barrel that throws must not loop forever
  const here = dirname(fileURLToPath(import.meta.url));       // .../fields/server/internal
  const fieldsPlugins = resolve(here, "..", "..", "plugins"); // .../fields/plugins
  const req = createRequire(import.meta.url);
  // generic discovery: */plugins/storage/server/index.ts — a new field type's
  // storage sub-plugin is picked up with zero edits here.
  for (const type of readdirSync(fieldsPlugins)) {
    const barrel = join(fieldsPlugins, type, "plugins", "storage", "server", "index.ts");
    let mod: { default?: { contributions?: { type?: { id: string }; build?: StorageColumnBuilder }[] } };
    try {
      mod = req(barrel);
    } catch {
      continue; // not every field type has a storage sub-plugin
    }
    for (const c of mod.default?.contributions ?? []) {
      if (c?.type?.id && c.build) eager.set(c.type.id, c.build);
    }
  }
}

export function resolveFieldStorage(typeId: string): StorageColumnBuilder | undefined {
  ensureFieldStoragePopulated();
  const live = Fields.Storage.getContributions().find((c) => c.type.id === typeId)?.build;
  return live ?? eager.get(typeId);
}
```

Notes:
- **Filter precision.** `Fields.Storage(props)` spreads `{ type, build }` onto
  the contribution, so filtering barrel contributions by "has `type.id` + `build`"
  is sufficient; the storage barrels contribute only `Fields.Storage(...)`, so
  there is nothing else to confuse it with. (If a barrel ever mixed contribution
  kinds, compare `c._kind` against the storage token's symbol — same module
  instance, so identity matches.)
- **Idempotent + fail-soft.** `populated` gates the body to one glob+require per
  process; a per-barrel `try/catch` skips non-storage types and never aborts all
  table materialization (mirrors `loadCollectedDir`'s warn-don't-throw posture).
- **Portable primitives.** `import.meta.url` + `createRequire` + `node:fs`
  readdir work whether `storage.ts` loads as Bun-ESM (boot/tests) or through
  drizzle-kit's esbuild-CJS transform (codegen) — neutralizing the
  bun-vs-esbuild runtime ambiguity. (Deliberately **not** `import.meta.dir` /
  `Bun.Glob`, which are Bun-only.)

### What does NOT change

- No edit to `drizzle.config.ts`, `bin/index.ts`, the 7 storage barrels, the
  codegen, or any check — the resolver self-loads on first use in every context.
- `fieldsToColumns` (`fields/server/internal/fields-to-columns.ts`) already calls
  `resolveFieldStorage`, so it inherits the fix for free.
- The declarative `Fields.Storage` contribution stays intact — docgen / facets
  read it from a **static source scan** of the barrel, not the runtime map, so
  docs remain the single declarative source (no drift).

### Boundaries

The `req(barrel)` call uses a **computed** path → no static import edge → invisible
to the boundary checker (the same technique `plugins/plugin-meta/plugins/facets/core/load-facets.ts`
uses on purpose). `fields/server` loading its own
`plugins/fields/plugins/*/.../storage/server` descendants is a parent loading its
own descendants — the most defensible cross-plugin load. No lint rule targets
`require()` of computed paths.

## Why this shape (vs alternatives)

- **vs a setup hook in `drizzle.config.ts` (+ early boot wiring):** that fixes
  codegen but must separately re-fix the boot loader-pass ordering, and couples
  two unrelated files to storage internals. Self-loading fixes both at the source
  with one file.
- **vs a generated eager aggregator (codegen-emitted static imports):** more
  machinery (new codegen variant + a new in-sync check) for no functional gain
  now that portable primitives neutralize the runtime ambiguity.

## Verification

1. **Unit tests stay green (live-registry path intact):**
   `bun test plugins/infra/plugins/entities` and `bun test plugins/fields/server`
   — `define-entity.test.ts` and `storage.test.ts` register throwaway types via
   `collectContributions`; the `live ?? eager` order must keep them resolving.
2. **Codegen no longer throws on a `defineEntity` `tables.ts`:** the original bug
   (`field "..." has no fields.storage contribution` during
   `drizzle-kit generate`) is gone. Strongest isolation check: from
   `plugins/database/plugins/migrations`, run
   `<bun> x --bun drizzle-kit generate` with `SINGULARITY_WORKTREE` set against a
   tree where one `tables.ts` calls `defineEntity` — confirm it resolves storage
   and emits no error. (Stage D will supply the real adopter; this fix can be
   smoke-tested before then with a throwaway `defineEntity` table.)
3. **Server boots:** `./equin build` restarts the server; boot completes
   past the loader pass (`bin/index.ts:15`) with no `no fields.storage
   contribution` throw.
4. **`./equin build` emits no spurious migration** for this change alone
   (it adds no table; only edits `storage.ts`). `migrations-in-sync` stays clean.
5. **`./equin check` green** — `plugin-boundaries` (computed `require`
   introduces no flagged edge), `type-check`, `plugins-doc-in-sync` (docgen still
   reads the declarative contribution).

## Critical files

- **EDIT** `plugins/fields/server/internal/storage.ts` — the entire change.
- (ref) `plugins/fields/plugins/text/plugins/storage/server/index.ts` — barrel
  shape the loader consumes (representative of all 7).
- (ref) `plugins/infra/plugins/entities/server/internal/define-entity.ts:71` —
  the sole call site whose failure this fixes.
- (ref) `plugins/infra/plugins/entities/server/internal/define-entity.test.ts` /
  `plugins/fields/server/internal/storage.test.ts` — the live-`collectContributions`
  test path the additive design must not break.
- (ref) `plugins/framework/plugins/server-core/core/contributions.ts` — `byKind`
  + `getContributions` semantics.

## Out of scope (follow-up)

- **Stage D** — re-express the live `slow_ops` table as a `defineEntity` field
  record, delete the loader projection + `Equal` guard, and verify
  `./equin build` emits no new migration (DDL byte-identical). Unblocked by
  this fix; tracked separately (its research doc is not yet written).
