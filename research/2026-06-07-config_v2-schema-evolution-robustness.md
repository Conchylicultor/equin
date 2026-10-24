# config_v2: robustness to schema evolution

## Context

User-created preprompts (the library at `conversations/preprompts/config.jsonc`,
e.g. "Auto-implement" / "Auto-push") **disappeared from the UI**. They are *not*
lost — the data is intact on disk at
`~/.singularity/config/singularity/conversations/preprompts/config.jsonc`, hash
matching origin (no hash conflict).

Root cause is a **read-time validation failure**:

1. The items were created 2026-06-05 with shape `{ id, rank, title, prompt }`.
2. Commit `f174f7b93` (2026-06-06, *"add icon selection per preprompt"*) added
   `icon: avatarField()` to the preprompts `itemFields`
   (`plugins/conversations/plugins/preprompts/shared/config.ts`).
3. `listField` builds its item schema by spreading each sub-field's schema
   **as required, with no default-backfill** (`list.ts`). The avatar schema is a
   required `z.object`, so every stored item now fails with
   `icon: expected object, received undefined`
   (reproduced against the real on-disk data).
4. `readTypedConfig` **silently** swaps the whole document for defaults on any
   parse failure (`tier-logic.ts:66-67`), so `preprompts` collapses to `[]` and
   the list renders empty. No warning, no UI signal — indistinguishable from
   "user has no preprompts".

This is a class-of-bug, not a preprompts bug: adding **any** field to **any**
`listField`/config retroactively invalidates every existing stored document, and
the only symptom is silent data disappearance.

### Two fixes (both requested by the user)

- **(A) Backfill missing fields from their own `defaultValue`** so adding a field
  is backward-compatible — a missing `icon` resolves to the avatar field's
  default (`{ icon: null, color: null, svgNodes: null }`, i.e. *no icon*) rather
  than being optional/undefined. **`objectField` already does exactly this**
  (`object.ts:36-57`: `field.schema.default(field.defaultValue)` + `.passthrough()`);
  `buildFieldsSchema` and `listField` are simply inconsistent with it. We make
  all three share one rule.
- **(B) Surface genuine validation failures in the settings UI** the same way a
  hash conflict is surfaced, instead of `readTypedConfig` silently returning
  defaults. After (A), additive changes self-heal and never surface; only
  truly-unhealable data (wrong types, corrupt docs) reaches this path.

Verified empirically: with default-backfill the real icon-less items parse and
heal (icon → default no-icon spec), while genuinely wrong data (e.g. `title` a
number) still fails — exactly the split we want.

---

## Part A — default-backfill for missing fields

### A1. New shared core helper

`plugins/config_v2/core/internal/schema-builder.ts` — add and export:

```ts
import type { FieldDef } from "./types";

// A missing key resolves to the field's own default, so adding a field to an
// existing config / list item / object is backward-compatible: documents that
// predate the field heal to its default instead of failing validation. Mirrors
// objectField, which already wraps its sub-fields this way.
export function fieldSchemaWithDefault(field: FieldDef): z.ZodTypeAny {
  return field.schema.default(field.defaultValue);
}
```

Re-export from `plugins/config_v2/core/index.ts` (alongside `buildFieldsSchema`).

### A2. Apply it in the three composition sites

1. **`buildFieldsSchema`** (`schema-builder.ts:4-12`) — top-level config object:
   ```ts
   for (const [key, field] of Object.entries(fields)) {
     shape[key] = fieldSchemaWithDefault(field);
   }
   return z.object(shape).passthrough() as ...;
   ```
   (`.passthrough()` for parity with object/list — unknown keys preserved, not
   stripped; redaction/tiers iterate `descriptor.fields` explicitly so extra keys
   are harmless.)

2. **`listField`** (`list.ts:41-52`) — per-item sub-fields:
   ```ts
   subShape[key] = fieldSchemaWithDefault(field);
   ```
   (item schema already `.passthrough()`; `id`/`rank` stay `.optional()`.)

3. **`objectField`** (`object.ts:36-57`) — replace the inline
   `field.schema.default(field.defaultValue)` with `fieldSchemaWithDefault(field)`.
   No behavior change — just routes the existing precedent through the shared
   helper so the rule lives in one place.

### A3. Self-healing on disk

No migration needed. Reads heal in-memory; the next `setConfig` writes a full
document (canonical write path already produces complete docs), so the on-disk
file gains `icon` on first edit. Existing `injectCollectionIds` (registry.ts:92)
is unaffected (it only injects `id`/`rank`).

**Note on `.default()` over `ZodEffects`:** avatar's schema is a `.transform()`.
`.default()` short-circuits to the default when input is `undefined` and
round-trips cleanly (verified). Works for every field type.

---

## Part B — surface genuine validation failures in the UI

Reuse the existing conflict channel (the user asked for "the same way as a hash
conflict"), adding an `invalid` variant.

### B1. Core: detection predicate

`plugins/config_v2/core/internal/tier-logic.ts` — add next to `hasConflict`:

```ts
// Human-readable issues if the effective document fails the descriptor schema
// even after default-backfill; null when it parses. Mirrors hasConflict: a pure
// predicate the server re-runs to populate the conflicts resource.
export function validationIssues(
  descriptor: ConfigDescriptor,
  origin: ConfigProxy,
  overwrites: ConfigProxy,
): string[] | null {
  const result = descriptor.schema.safeParse(effective(origin, overwrites));
  if (result.success) return null;
  return result.error.issues.map(
    (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
  );
}
```

Also add a `console.warn` in `readTypedConfig` on the failure branch (fail-loud
in logs); keep the defaults fallback so the running app stays alive (mirrors
hash-conflict semantics: app resolves to a safe value, UI surfaces the problem).
Re-export `validationIssues` from `core/index.ts`.

### B2. Core: extend the conflict entry shape

`plugins/config_v2/core/internal/resource.ts:13-18`:

```ts
export const configV2ConflictEntrySchema = z.object({
  kind: z.enum(["hash", "invalid"]).default("hash"),
  originValues: z.record(z.unknown()),
  overrideValues: z.record(z.unknown()),
  issues: z.array(z.string()).optional(), // present when kind === "invalid"
});
```

`kind` defaults to `"hash"` so existing emit sites need no change.

### B3. Server: emit invalid entries

`plugins/config_v2/server/internal/resource.ts` — in `computeAllConflicts()`
(~line 110-130), per descriptor:

- If `hasConflict(...)` → existing hash entry (unchanged; `kind: "hash"`).
- Else if `validationIssues(descriptor, origin, overwrites)` is non-null →
  emit `{ kind: "invalid", originValues: descriptor.defaults, overrideValues:
  <effective/override raw content>, issues }`.

Hash conflict takes precedence (origin already wins and is presumably valid;
reconciling re-evaluates). The existing file-watcher path
(`registry.ts:130` → `configV2ConflictsServerResource.notify()`) already
re-emits on any change — no extra wiring.

### B4. UI: invalid banner variant

`plugins/config_v2/plugins/settings/web/components/config-detail.tsx` — in the
`conflictEntry && (...)` block (lines ~142-187), branch on `conflictEntry.kind`:

- `"hash"` → existing soft/hard conflict rendering (unchanged).
- `"invalid"` → destructive-styled banner: *"Stored config is invalid for the
  current schema"* + the `issues` list, with actions:
  - **Reset to defaults** → reuse `handleAcceptAll` (`deleteOverride`), which
    drops the bad override.
  - **View raw** → toggle the existing `showRaw` (`RawFileView`) so the user can
    inspect/fix the stored file manually.

No new endpoint needed — `deleteOverride` and `getConfigRawFile` already exist.

---

## Critical files

| File | Change |
|---|---|
| `plugins/config_v2/core/internal/schema-builder.ts` | add `fieldSchemaWithDefault`; apply in `buildFieldsSchema` + `.passthrough()` |
| `plugins/config_v2/core/index.ts` | export `fieldSchemaWithDefault`, `validationIssues` |
| `plugins/config_v2/plugins/fields/plugins/list/core/internal/list.ts` | use `fieldSchemaWithDefault` for item sub-fields |
| `plugins/config_v2/plugins/fields/plugins/object/core/internal/object.ts` | route through `fieldSchemaWithDefault` (no behavior change) |
| `plugins/config_v2/core/internal/tier-logic.ts` | add `validationIssues`; `console.warn` in `readTypedConfig` failure branch |
| `plugins/config_v2/core/internal/resource.ts` | extend `configV2ConflictEntrySchema` with `kind` + `issues` |
| `plugins/config_v2/server/internal/resource.ts` | emit `kind: "invalid"` entries in `computeAllConflicts()` |
| `plugins/config_v2/plugins/settings/web/components/config-detail.tsx` | render the `invalid` banner variant |

## Verification

1. **The actual regression (A).** `./equin build`, open the main namespace
   preprompts config
   (`http://equin.localhost:9000/agents/config/cd/conversations%252Fpreprompts%252Fconfig.jsonc`).
   Both "Auto-implement" and "Auto-push" reappear, each with a default (no) icon.
   Confirm they're selectable again in the task/draft PrepromptSelect.
2. **On-disk self-heal (A).** Edit one preprompt in the UI, then inspect
   `~/.singularity/config/singularity/conversations/preprompts/config.jsonc` —
   the rewritten doc now carries an `icon` key per item.
3. **Invalid surfacing (B).** Hand-write an invalid override for a throwaway
   config (e.g. a `textField` value set to a number) keeping the correct
   `// @hash`, reload its settings detail → destructive "invalid" banner with the
   zod issue and **Reset to defaults** / **View raw** actions; the server logs
   the `console.warn`. Click **Reset to defaults** → banner clears, value returns
   to default.
4. **No regressions.** `./equin check` (eslint + boundaries +
   config-origins-in-sync). Existing hash-conflict flow still renders/behaves as
   before (its entries default to `kind: "hash"`).

## Out of scope / notes

- If invalid data lives in the **git origin** (not the user override),
  *Reset to defaults* (delete-override) won't clear it; the user must fix the
  committed `config/.../*.jsonc`. Rare; the banner + raw view still make it
  visible. Not handled here.
- Load-bearing `config_v2` core is touched — requires explicit user approval
  before implementation.
