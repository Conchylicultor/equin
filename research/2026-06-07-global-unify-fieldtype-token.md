# Unify the FieldType token — `fields/core` owns it, `config_v2/core` re-exports temporarily

## Context

This is **task 4** of the unified-fields migration chain
(`research/2026-06-06-global-unified-fields-primitive.md`, stage **S1**). Tasks 1–3 already
landed: `plugins/fields/core` exists and defines the canonical `FieldType` token
(`defineFieldType`), `FieldIdentity` (`defineFieldIdentity`, with `extends`/`coerce`), and
`resolveTypeChain`. The data-view capability slots and the remaining field types are populated.

The problem this task fixes: there are **two parallel, structurally-identical-but-nominally-separate**
definitions of the token.

- `plugins/fields/core/internal/types.ts` + `internal/define.ts` — the *canonical* `FieldType` /
  `defineFieldType` (the intended single source).
- `plugins/config_v2/core/internal/types.ts:22-29` — config_v2's **own private copy** of
  `FieldType` + `defineFieldType`, used by `FieldDef` and re-exported from
  `config_v2/core/index.ts`. All ~13 config field-type plugins (`primitives`, `enum`, `color`,
  `secret`, `list`, `object`, …) import `defineFieldType` from `@plugins/config_v2/core`.

The two `defineFieldType` implementations are **byte-identical** (`Object.freeze({ id })`) and the
config renderer slot (`config-v2.fields.renderer`) dispatches purely on the **string**
`field.type.id` (`plugins/config_v2/plugins/fields/web/internal/slots.tsx:17-33`), not on object
reference. So collapsing config_v2's copy onto fields/core's is **fully behavior-preserving** — every
field type renders exactly as before.

**Goal:** make `config_v2/core` consume the token from `@plugins/fields/core` and re-export it
through its barrel as a **temporary, documented shim**, so the ~13 importers migrate to
`@plugins/fields/core` incrementally (tasks 5–7), with the shim removed in task 8 (stage S4). Because
a barrel re-export from another plugin violates the `cross-plugin-reexport` boundary rule, this task
also adds a **scoped, documented allowlist entry** to the `plugin-boundaries` check — the sanctioned
exception the design calls for (research doc, Risk 3).

## Approach

Three files change. The two new cross-plugin edges this introduces (`config_v2/core → fields/core`,
core runtime) **do not create a cycle**: the only existing `fields → config_v2` import is from the
distinct leaf node `fields/plugins/enum/plugins/config → config_v2/plugins/fields` — different plugin
nodes from `fields` and `config_v2`, so the per-runtime cycle detector sees no back-edge. Verified;
`fields` (umbrella) and `config_v2` (umbrella) do not import each other today.

### 1. `plugins/config_v2/core/internal/types.ts` — drop the private copy, import the canonical token

- Delete the local `export interface FieldType<T>` (lines 22-25) and
  `export function defineFieldType<T>` (lines 27-29).
- Add `import type { FieldType } from "@plugins/fields/core";` (a legal cross-plugin core→core
  import — `@plugins/<name>/core` is allowed by R4 grammar and by `no-plugin-imports-in-core`).
- `FieldDef.type: FieldType<T>` now references the canonical type — identical shape, no churn for the
  40+ `FieldDef` importers.
- Leave `FieldMeta` as-is (config_v2 keeps its own; unifying `FieldMeta` is **out of scope** for this
  task — it's the token only).

### 2. `plugins/config_v2/core/index.ts` — temporary re-export shim

- Remove `FieldType` from the `export type { … } from "./internal/types"` list (line 8) and remove
  `export { defineFieldType } from "./internal/types"` (line 3).
- Add the honest, visible re-export from the canonical source, with a doc comment that names the
  migration and its removal condition:

```ts
// TEMPORARY re-export shim — unified-fields migration, stage S1→S4
// (research/2026-06-07-global-unify-fieldtype-token.md). fields/core now owns the
// FieldType token; config_v2's ~13 field-type plugins migrate to @plugins/fields/core
// incrementally (tasks 5–7). Remove this block AND its plugin-boundaries allowlist
// entry once the last importer is migrated (task 8). Sanctioned cross-plugin re-export.
export { defineFieldType } from "@plugins/fields/core";
export type { FieldType } from "@plugins/fields/core";
```

`config_v2/core`'s public surface is unchanged (still exports `defineFieldType` + `FieldType`), so no
importer breaks.

### 3. `plugins/framework/plugins/tooling/plugins/checks/plugins/plugin-boundaries/check/index.ts` — scoped allowlist

The honest barrel re-export trips the `cross-plugin-reexport` rule
(`checkBarrelPurity`, lines 543-562). Add a **targeted, documented exception** — mirroring the
established `runtimeExceptions` pattern in `boundaries/boundary-config.ts` (a string-keyed allowlist
with a comment), rather than the heavy whole-plugin `SKIPPED_PLUGINS` (which would disable *all* rules
for config_v2).

- Add a constant near `SKIPPED_PLUGINS` (line 8):

```ts
// Sanctioned, TEMPORARY cross-plugin barrel re-exports for gradual migrations.
// Key: `${reexporting-plugin}/${runtime} -> ${source-specifier}`. Normally forbidden
// by the cross-plugin-reexport rule; each entry is a scoped, documented exception
// removed once all importers move to the source barrel directly.
const REEXPORT_EXCEPTIONS: ReadonlySet<string> = new Set([
  // Unified-fields migration (research/2026-06-07-global-unify-fieldtype-token.md, S1→S4):
  // config_v2/core temporarily re-exports the FieldType token from fields/core.
  // Remove with the shim in task 8.
  "config_v2/core -> @plugins/fields/core",
]);
```

- Thread the loop's `runtime` into `checkBarrelPurity` (add a param; the call site at line 123 is
  already inside `for (const runtime of [...])`).
- In the violation branch (line 552), guard the push:

```ts
if (specPluginPath !== pluginPath) {
  const exceptionKey = `${pluginPath}/${runtime} -> ${specifier}`;
  if (!REEXPORT_EXCEPTIONS.has(exceptionKey)) {
    violations.push({ rule: "cross-plugin-reexport", … });
  }
}
```

One entry covers both shim lines (same plugin/runtime/specifier). Note: editing the boundary check is
normally discouraged (`PUSH_BACK_HINT`); this is the explicitly user-sanctioned exception the design
calls for, so it is in-scope here.

## Critical files

- `plugins/config_v2/core/internal/types.ts` — remove private `FieldType`/`defineFieldType`, import from `@plugins/fields/core`.
- `plugins/config_v2/core/index.ts` — the temporary re-export shim (origin of the sanctioned exception).
- `plugins/framework/plugins/tooling/plugins/checks/plugins/plugin-boundaries/check/index.ts` — `REEXPORT_EXCEPTIONS` allowlist + `checkBarrelPurity` guard.
- `plugins/fields/core/{internal/types.ts,internal/define.ts,index.ts}` — the canonical token (reference only, **not modified**).

## Non-goals

- Unifying `FieldMeta` (config_v2 keeps its own copy).
- Migrating the ~13 config field-type plugins off `@plugins/config_v2/core` (tasks 5–7).
- Removing the shim / re-enabling strict boundaries (task 8).
- Any change to `config-v2.fields.renderer` dispatch, slot ids, resource ids, or storage-provider keys.

## Verification

1. `./equin build` — succeeds; regenerates docs (the `config_v2 → fields` edge appears in
   `docs/plugins-*.md` and the config_v2 CLAUDE.md autogen block) and migrations stay in sync.
2. `./equin check` — all pass. Specifically `plugin-boundaries` passes (the one re-export is
   allowlisted; everything else still enforced), plus `plugins-doc-in-sync`, `eslint`, `typescript`.
3. Sanity that the exception is *scoped*: temporarily add an unrelated cross-plugin re-export to some
   other barrel → `plugin-boundaries` still fails on it (confirms we didn't broaden the rule). Revert.
4. Open `http://att-1780828429-mxgq.localhost:9000` → Settings pane: every existing config field type
   (bool, text, int, float, enum, color, avatar, secret, list, object, multiline, dynamic-enum)
   renders and edits exactly as before — confirms the token swap is behavior-preserving and
   `field.type.id` dispatch is intact.
5. Grep guard: `rg -n 'interface FieldType|function defineFieldType' plugins/config_v2/core` returns
   nothing (the private copy is gone); `rg -n 'from "@plugins/config_v2/core"' plugins | rg defineFieldType`
   still resolves (importers unaffected via the shim).
