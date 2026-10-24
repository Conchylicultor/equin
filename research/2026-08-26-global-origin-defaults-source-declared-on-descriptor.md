# A descriptor declares where its origin defaults come from

## Context

`readGitLayerConfig`
([`codegen/core/git-layer-config.ts`](../plugins/framework/plugins/tooling/plugins/codegen/core/git-layer-config.ts))
decides whether a committed `config/<hier>/<name>.origin.jsonc` is stale by
comparing its `// @hash` header against `computeHash(descriptor.defaults)`.

That basis is right for almost every descriptor and wrong for one family. The
origin generator writes `computeHash(provider(descriptor) ?? descriptor.defaults)`
([`config-origin-gen.ts:290`](../plugins/framework/plugins/tooling/plugins/codegen/core/config-origin-gen.ts)),
and reorder directive descriptors get their defaults from that provider — the live
contribution catalog, built by an async preparer that needs primed barrels
([`reorderable-slots-gen.ts:268`](../plugins/framework/plugins/tooling/plugins/codegen/core/reorderable-slots-gen.ts)).
For those, the committed hash can never match `descriptor.defaults`, so the origin
always reads as stale and the helper answers with the wrong document.

The wrong answer is slightly worse than "the empty code defaults". When the origin
degrades to `null`, `nonStaleOverrideContent`
([`tier-logic.ts:35`](../plugins/config_v2/core/internal/tier-logic.ts)) has no
origin to compare the override against, so it skips its own staleness test and
applies the committed override **unvalidated**. Reorder descriptors do have
committed overrides (`config/shell/toolbar.jsonc` and ~40 others), so the practical
result is "a possibly-stale authored file wins, silently".

There is no live instance: the only caller is `readCompositionManifestsFromDisk`
([`main-bundle.ts:43`](../plugins/framework/plugins/tooling/plugins/codegen/core/main-bundle.ts))
with `compositionsConfig`, whose defaults are static. But `readGitLayerConfig` is a
public export of the codegen barrel, and the only thing stopping a future caller is
the SCOPE paragraph on `nonStaleOriginProxy` — rung 5, the weakest rung.

The staleness rule itself has to stay. It exists because registry codegen (build
stage 1) runs before `generateConfigOrigins` (stage 2, step 7), and
`generateConfigOrigins` itself calls back into `readCompositionManifestsFromDisk`
to decide which descriptors get origins at all — so the compositions origin cannot
be regenerated before the read that needs it. Introduced by
[`2026-08-21-global-one-mechanism-for-plugin-exclusion.md`](./2026-08-21-global-one-mechanism-for-plugin-exclusion.md)
(design item 4).

**Outcome.** A descriptor states where its origin defaults come from. Pointing
`readGitLayerConfig` at a build-materialized descriptor becomes a `tsc` error
(rung 2), and the generator throws if a descriptor's claim and the provider's
behaviour disagree (rung 4). The prose SCOPE paragraph stops being the enforcement.

---

## The declaration

`ConfigDescriptor` gains a **required** `originDefaultsFrom`, carried as a second
(defaulted) type parameter so it can be constrained at a call site.

```ts
// plugins/config_v2/core/internal/types.ts
export type OriginDefaultsFrom = "descriptor" | "build";

export interface ConfigDescriptor<
  F extends FieldsRecord = FieldsRecord,
  O extends OriginDefaultsFrom = OriginDefaultsFrom,
> {
  …
  readonly originDefaultsFrom: O;
}
```

Named `originDefaultsFrom`, not `originDefaults`: the latter is already the name of
the provider *function* in the one file where both would appear together
(`renderOriginJsonc`'s parameter, `resolveOriginDefaults`, `OriginDefaultsProvider`).

**Not** reusing the existing `source: "manual" | "reorder" | "view"`. It is
optional, documented as cosmetic (a settings-nav badge, its only consumer), and the
correlation with materialization is coincidental — the property that matters is
"does a provider supply my origin defaults", not who authored me. Its own doc says
it was named `source` *to avoid* colliding with origin-layer terminology.

### Constructing it

Use **overloads**, not inference from an optional property. With
`originDefaultsFrom?: O` and no `exactOptionalPropertyTypes`, a caller passing
`cond ? "build" : undefined` (or a `OriginDefaultsFrom`-typed variable) makes `O`
fall back to the *constraint*, silently widening to the union and re-opening the
hole. Overloads mean `O` is never inferred:

```ts
// plugins/config_v2/core/internal/define-config.ts
export function defineConfig<const F extends FieldsRecord>(
  opts: DefineConfigOpts<F> & { originDefaultsFrom?: "descriptor" },
): ConfigDescriptor<F, "descriptor">;
export function defineConfig<const F extends FieldsRecord>(
  opts: DefineConfigOpts<F> & { originDefaultsFrom: "build" },
): ConfigDescriptor<F, "build">;
export function defineConfig<const F extends FieldsRecord>(
  opts: DefineConfigOpts<F> & { originDefaultsFrom?: OriginDefaultsFrom },
): ConfigDescriptor<F> { /* existing body */ }
```

The frozen object needs `originDefaultsFrom: (opts.originDefaultsFrom ?? "descriptor") as O`
— the same shape as the existing `as ConfigValues<F>` cast on the line above.

The type-parameter **default on the interface** is what keeps the ~148 bare
`ConfigDescriptor` references compiling; the overloads are a separate mechanism for
the constructor. Both are needed.

### Why an interface with a type param, not a union

A genuine `DescriptorOriginConfig<F> | BuildOriginConfig<F>` union would give free
narrowing, but nothing needs narrowing today (the sole caller holds a concrete
descriptor), and it would make `isConfigDescriptor`
([`config-origin-gen.ts:46`](../plugins/framework/plugins/tooling/plugins/codegen/core/config-origin-gen.ts))
an unsound predicate — it narrows `unknown` from dynamically imported server barrels
and would be asserting one arm of a union without checking the discriminant. If a
caller ever needs narrowing, add a guard beside `readGitLayerConfig`:

```ts
export function hasDescriptorOrigin<F extends FieldsRecord>(
  d: ConfigDescriptor<F>,
): d is ConfigDescriptor<F, "descriptor"> {
  return d.originDefaultsFrom === "descriptor";
}
```

---

## Changes

Ordered; each is small.

1. **[`plugins/config_v2/core/internal/types.ts`](../plugins/config_v2/core/internal/types.ts)**
   — add `OriginDefaultsFrom`, the second type param on `ConfigDescriptor`, and the
   required `originDefaultsFrom`. Document *why* (it is the staleness basis), not
   just what.

2. **[`plugins/config_v2/core/internal/define-config.ts`](../plugins/config_v2/core/internal/define-config.ts)**
   — extract `DefineConfigOpts<F>`, add the three signatures above, set the field in
   the frozen object.

3. **[`plugins/config_v2/core/index.ts`](../plugins/config_v2/core/index.ts)** —
   export `type { OriginDefaultsFrom }` beside `ConfigSource`.

4. **[`plugins/reorder/shared/directive.ts`](../plugins/reorder/shared/directive.ts)**
   — pass `originDefaultsFrom: "build"`, and widen the declared return type at
   line 47 to `ConfigDescriptor<{ items: ReorderTreeFieldDef }, "build">`. This is
   the only `"build"` descriptor in the repo.

5. **[`git-layer-config.ts`](../plugins/framework/plugins/tooling/plugins/codegen/core/git-layer-config.ts)**
   — tighten the parameter to `ConfigDescriptor<F, "descriptor">`; add a one-line
   runtime throw in `nonStaleOriginProxy` for the erased paths (the four
   `as unknown as ConfigDescriptor` casts, `loadConfigDescriptorsByOriginPath`'s
   `Map<string, ConfigDescriptor>`, and `discoverConfigs`'s dynamic barrel imports).
   Rewrite the SCOPE paragraph so it *points at* the gate instead of describing the
   hazard.

6. **[`config-origin-gen.ts`](../plugins/framework/plugins/tooling/plugins/codegen/core/config-origin-gen.ts)**
   — two edits:
   - `isConfigDescriptor` (line 46) also checks `typeof obj.originDefaultsFrom === "string"`,
     so the predicate stops asserting a required field it never verified.
   - `renderOriginJsonc` (line 290) asserts the descriptor's claim and the provider's
     behaviour agree, **both ways** — the declaration is otherwise a claim nothing
     checks, since the provider decides applicability by catalog membership:

     ```ts
     const materialized = originDefaults?.(descriptor, hierarchyPath);
     if (materialized && descriptor.originDefaultsFrom !== "build") throw …;
     if (!materialized && descriptor.originDefaultsFrom === "build") throw …;
     const defaults = materialized ?? descriptor.defaults;
     ```

     Every generated origin flows through here, and it runs in both the build and
     the `config-origins-in-sync` check process, so one assert covers the surface.

7. **[`reorderable-slots-gen.ts`](../plugins/framework/plugins/tooling/plugins/codegen/core/reorderable-slots-gen.ts)**
   — required by the second arm of step 6. Today `collectReorderableSlots` only
   creates a catalog entry for a slot that has at least one bundled contribution, so
   a **contribution-free** reorderable slot misses the lookup and the provider
   returns `undefined` — indistinguishable from "not my descriptor". Pre-seed
   `catalog` with `address → []` for every entry of `slots` before the contribution
   walk. Then `undefined` means exactly "not a build-materialized descriptor".

   This is **byte-neutral**: `reorderTreeField`'s `defaultValue` is `[]`, so
   `{ items: [] }` and `descriptor.defaults` render the same body and the same hash;
   and `buildOriginAnnotationsProvider` already returns `[]` for both a miss and an
   empty array (line 244). No origin file changes, no override goes stale.

8. **[`define-variant-region.ts`](../plugins/ui/plugins/variant-region/core/define-variant-region.ts)
   lines 19 and 36** — the annotation `ConfigDescriptor<VariantRegionFields>` around
   a `defineConfig` result widens `O` back to the union. Narrow to
   `ConfigDescriptor<VariantRegionFields, "descriptor">`, or drop the annotation at
   line 36 and let it infer.

**Deliberately left bare** (`ConfigDescriptor` with no second arg): the container
maps in `reorder/web/internal/descriptors.ts`, `views-descriptor.ts`,
`data-view/*/descriptors.ts`, and the `FxToggleConfig` alias in
`sonata/piano-roll/web/slots.ts`. Threading `"descriptor"` through them is churn
with no consumer, and the gate stays sound — see below.

### The design is fail-closed

Forgetting an annotation cannot produce a silent wrong answer:

| Mistake | Result |
|---|---|
| A `"build"` descriptor widened to the union | Still a `tsc` error at `readGitLayerConfig`. Fixing it is documentation value only. |
| A `"descriptor"` descriptor widened to the union | A *spurious* error at a future call — friction, never a wrong answer. |
| A bare `ConfigDescriptor` passed in | Rejected: the union is not assignable to `"descriptor"`. |

The only false accepts are an explicit `ConfigDescriptor<F, "descriptor">`
annotation on a build-materialized descriptor, or a cast — both deliberate acts,
and the runtime throw from step 5 catches the cast.

---

## Verification

1. `./equin build` (background) — must be **byte-clean**: no change to any
   `config/**/*.origin.jsonc` and no `@review` marker minted. Step 7 is the one that
   could break this; `git status config/` proves it did not.
2. `./equin check` — `type-check`, `config-origins-in-sync`,
   `config:overrides-authored`, `plugins-registry-in-sync`, `composition-closure`.
   The type lives in `core`, so tsc covers it under `server-core`, `central-core`,
   `web-core`, `tsconfig.tools.json` and `tsconfig.test.json`.
3. **Prove the gate bites.** Temporarily add
   `readGitLayerConfig(reorderDirectiveDescriptor("x"), { root, hierarchyPath })`
   and confirm tsc reports `Type '"build"' is not assignable to type '"descriptor"'`.
   Revert.
4. **Prove the generator assert bites.** Temporarily flip `directive.ts` to
   `originDefaultsFrom: "descriptor"` and confirm `./equin check config-origins-in-sync`
   fails with the new message rather than silently rewriting origins. Revert.
5. `./equin test plugins/framework/plugins/tooling/plugins/codegen` and
   `./equin test plugins/config_v2`. Add a case to
   `config-origin-gen.test.ts` covering both arms of the step-6 assert.

---

## Adjacent findings — same root cause, not in this plan

While sweeping for "who else treats `descriptor.defaults` as what the origin says",
two **live** instances turned up. They are separate bugs with their own blast
radius; recommend filing them rather than folding them in here.

1. **Per-field Reset writes the code default, not the origin's.**
   `resetConfigByPath` ([`config_v2/server/internal/registry.ts:634`](../plugins/config_v2/server/internal/registry.ts))
   ends with `setConfig(descriptor, key, descriptor.defaults[key])` for any field
   with no `FieldStorageProvider` — and only `secretField` has one. So pressing
   Reset on a reorder slot's **Items** field writes an *override* of `items: []`,
   discarding the committed arrangement, instead of restoring the origin's
   materialized catalog. The whole-config path next to it,
   `deleteOverrideByPath` (line 825), gets it right — it deletes the override and
   lets `refreshEntry` re-resolve against the real origin on disk. Fix shape: take
   the reset value from the origin document, not from `descriptor.defaults`.

2. **The Settings "modified" indicators compare against code defaults.**
   `computeModifiedCount` ([`resource.ts:386`](../plugins/config_v2/server/internal/resource.ts)),
   `config-field.tsx:22` and `config-detail.tsx:184` all diff the live values
   against `descriptor.defaults`. For a static descriptor that equals the origin, so
   it reads correctly; for a reorder descriptor the origin is the catalog and the
   default is `[]`, so **every reorder config permanently reports as modified**.
   This one needs a product decision first — whether "modified" means "differs from
   the code default" or "has an override" — so it is a design question, not a patch.

Everything else that compares an origin hash is already safe: `tier-logic.ts`,
`authored-override-seed.ts`, `config-origins-in-sync` and the `fileConfigProxy`
paths all hash the origin's **on-disk content**, never the descriptor.
