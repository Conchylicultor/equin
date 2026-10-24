# Enforce: DB-backed keyed resources declare scoped-recompute coverage

> **Category:** global (resource-runtime, server-core, tooling/checks)
> **Status:** design / plan (no code yet)
> **Source substrate (landed):** [`2026-06-20-global-scoped-recompute-default.md`](./2026-06-20-global-scoped-recompute-default.md) — commit `986d21ec1`. This task is that doc's Follow-up #2 ("Scheduler 'scope mandatory' enforcement").
> **Sibling model:** [`2026-06-19-global-live-state-work-admission-model.md`](./2026-06-19-global-live-state-work-admission-model.md) §6 — the three enforcement layers (types make wrong *unwritable*; checks make it *uncommittable*; budgets make re-emergence *undeployable*).

## 1. Context

Commit `986d21ec1` made scoped recompute the default-when-safe: a keyed resource
declares `identityTable` (its own key-space base table) plus `affectedMap` edges,
and the L4 change-feed routes a single-row change to only the affected keys
instead of FULL-rebuilding the whole `conversations → attempts → tasks` cascade.

But `identityTable` shipped as an **optional** field. A keyed, DB-backed resource
that simply forgets it falls all the way back to FULL recompute — and **that
fallback is silent**: nothing at author-time, build-time, or runtime says "this
resource degraded the cascade you just spent effort scoping." The source doc names
the fix explicitly (§4): *"a per-resource recompute policy + a `./equin
check` that fails when a DB-backed keyed resource lacks `identityTable`/edge
coverage."* This is the missing **policy** half — co-designed against the same
`identityTable` / `affectedMap` / `coveredOrigins` substrate so the two are one
mechanism, not two.

**Decision rule the substrate already runs** (`runtime.ts:516 coveredOriginsFor`,
`applyDbChange`) for a change with origin base-table `B` and resource `R`:
`B == identityTable(R)` → **scoped**; `B ∈ coveredOrigins(R)` (transitive closure
of `identityTable` over `affectedMap` edges) → **suppressed** (an edge delivers
it); else → **FULL**. A keyed resource therefore silently FULLs on its *own* table
the moment `identityTable` is absent. That is the floor this task makes
impossible to leave undeclared.

**Outcome wanted:** a keyed DB-backed resource cannot *silently* fall to FULL.
It must either declare `identityTable` (scoped) or explicitly declare
`recompute: "full"` with a reason — making FULL a deliberate, documented choice.
Enforced two ways: a **type constraint** (mandatory-by-construction, the strongest
layer) and a **build-gating check** (the uncommittable backstop).

## 2. Scope of this task (and the honest boundary)

Statically we can enforce the **floor**: own-table coverage is *declared*. We
**cannot** statically verify the **ceiling** — that the declared `identityTable` +
`affectedMap` edges actually cover *every* table the loader reads — because the
read-set (which DB tables a loader queries) is only known at runtime
(`getReadSetIndex()`, populated after the loader runs against a live DB; surfaced
in the read-set debug pane). A keyed resource that reads a second base table with
no covering edge still FULLs on that table — the type/check pass, the gap remains.

That ceiling is **deferred** (see §6) as a runtime diagnostic on the existing
read-set pane — the only place the read-set is knowable. This task ships the
floor: type + check + the explicit-FULL policy field. (Migration cost is **zero** —
all three current keyed DB-backed resources, `attempts` / `tasks` /
`agent-launches`, already declare `identityTable`.)

## 3. Part A — the per-resource recompute policy (type-level, primary)

The strongest enforcement is mandatory-by-construction: a keyed DB-backed resource
that omits both `identityTable` and the explicit opt-out is a **`tsc` error**, not
a missed review. This also eliminates the static check's one structural blind spot
— a loader that does its DB work through an *imported helper* (no inline `db.`)
would slip a `db.`-heuristic check; the type catches it regardless.

### A1. Add the explicit-FULL opt-out field

`plugins/framework/plugins/resource-runtime/core/runtime.ts` — extend
`ResourceDefinition<T,P>` (after `identityTable`, line 143):

```ts
/**
 * Explicit opt-out: this keyed resource intentionally FULL-recomputes (its key is
 * not a single base-table PK, or its read is irreducibly whole-set). Required ON A
 * KEYED RESOURCE when `identityTable` is omitted, so a FULL fallback is always a
 * declared, documented choice — never a silent default. `reason` is surfaced in
 * the read-set debug pane and read by the future work-admission scheduler when it
 * decides whether to admit a FULL recompute intent.
 */
recompute?: { kind: "full"; reason: string };
```

The runtime keeps treating "no `identityTable`" as FULL behaviourally — `recompute`
is **declaration-only** today (functionally inert; it documents intent and is read
by the check + the future scheduler). Copy it onto `RegistryEntry` (mirror the
`identityTable: def.identityTable` line at `runtime.ts:679`) so the read-set pane
and scheduler can read it later. No behavioural change.

> `identityTable` stays valid on **`push`/`invalidate`** resources too
> (`conversationsLiveResource` is `push` + `identityTable: "conversations"` — it
> propagates scoped ids downstream). The constraint below applies the requirement
> **only to `keyed` mode**.

### A2. Constrain the `defineResource` input type

Introduce a discriminated input type so `mode: "keyed"` requires `keyOf` **and**
(`identityTable` XOR `recompute`). The runtime's internal `ResourceDefinition` stays
loose (the registry and generic `createResource` keep using it); the constraint
lives at the **public `defineResource` facade signature** only.

`plugins/framework/plugins/server-core/core/resources.ts` (and the identical
re-export shape — see note) — re-type the exported `defineResource`:

```ts
// Keyed resources must declare their scope policy; non-keyed may still set identityTable.
type ScopePolicy = { identityTable: string; recompute?: never }
                 | { recompute: { kind: "full"; reason: string }; identityTable?: never };

type DefineResourceInput<T, P extends ResourceParams> =
  | (Omit<ResourceDefinition<T, P>, "mode" | "keyOf" | "identityTable" | "recompute">
      & { mode?: "push" | "invalidate"; identityTable?: string })          // non-keyed branch
  | (Omit<ResourceDefinition<T, P>, "mode" | "keyOf" | "identityTable" | "recompute">
      & { mode: "keyed"; keyOf: (row: any) => string } & ScopePolicy);     // keyed branch
```

Type `defineResource` as `<T, P>(def: DefineResourceInput<T, P>) => Resource<T, P>`.
This subsumes the existing runtime throw `mode "keyed" requires a keyOf`
(`runtime.ts:641`) at the type level — keep the throw as a defensive guard for JS
callers. `defineExternalResource` is **unchanged** (keyed external resources have
no `identityTable` — their truth is non-DB and notify-driven).

> **Seam note.** `defineResource` is destructured from the runtime
> (`server-core/core/resources.ts:140`, `central-core` likewise). Apply the strict
> type by re-exporting with a cast at the facade
> (`export const defineResource = runtime.defineResource as DefineResourceFn`), or by
> tightening the runtime's exported signature directly. Prefer constraining at the
> runtime export so **both** facades inherit it consistently — there are no central
> or external keyed resources today, and a future central keyed resource would
> honestly declare `recompute: "full"` (no DB feed to scope against).

### A3. `identityTable` doc hardening

Tighten the `identityTable` JSDoc (`runtime.ts:130`) to state it is **always a base
table name, never a view name** — `applyDbChange`'s `origin` is always a base table,
so a view name here silently never matches (exactly the silent-FULL class this task
closes). Cheap, prevents a footgun the check can't see.

## 4. Part B — the build-gating check (backstop, uncommittable layer)

A new plugin-contributed check, mirroring `no-db-backed-notify` byte-for-byte (the
closest precedent — a resource-shaped static scan). It is a **backstop**: the type
is primary, but the check catches type bypasses (`as any`, `// @ts-ignore`, a local
`defineResource` wrapper) and guards against a future weakening of the type.

**New sub-plugin:** `plugins/framework/plugins/tooling/plugins/checks/plugins/keyed-resource-scope/`
with `check/index.ts` (default-export a `Check`) and a stub `CLAUDE.md`.

**Logic** (reuse `grepCode` + `maskSource` + the paren-depth span walk from
`no-db-backed-notify/check/index.ts`, and `parseStringField` /
`findMarkerCalls` from `parse-utils/core`):

1. `grepCode({ pattern: /defineResource\(/, grepArg: "defineResource(", fixed: true, maskStrings: true })`
   → candidate files. (`defineResource` is **not** a substring of
   `defineExternalResource`, so no collision.)
2. For each candidate, mask the source and walk each `defineResource(` call's
   argument span (paren-depth counter — identical to `externalResourceSpans`).
3. Within a span: `mode = parseStringField(span, "mode")`. In scope iff
   `mode === "keyed"`.
4. FAIL the span iff keyed **and** it has neither `identityTable` (`/\bidentityTable\s*:/`
   over the masked span) **nor** the opt-out (`/\brecompute\s*:/`).
5. Message lists `path:line` offenders; `hint` explains: declare `identityTable`
   (the base table whose PK == `keyOf`'s id) so a change scopes to your own keys,
   or `recompute: { kind: "full", reason }` to opt into FULL deliberately.

**Known limitation (document in the check description):** the static scan reads only
the call body, so a keyed resource whose loader delegates DB work to an imported
helper is invisible to a `db.`-presence heuristic — which is exactly why Part A (the
type) is primary and this check is the backstop. The check does **not** test for
`db.` at all; it tests the *declaration* (`mode: "keyed"` ⇒ a scope policy is
present in the span), which the type already guarantees for non-bypassed sites.

No registry edits: `./equin build` regenerates
`checks/core/check.generated.ts` from the filesystem (the
`plugins-registry-in-sync` check enforces no drift). `cacheSignature` absent
(pure function of tree content).

## 5. Critical files

- `plugins/framework/plugins/resource-runtime/core/runtime.ts` — add `recompute` to
  `ResourceDefinition` + `RegistryEntry` (`:143`, `:679`); harden `identityTable`
  JSDoc (`:130`); tighten exported `defineResource` signature.
- `plugins/framework/plugins/server-core/core/resources.ts` — `DefineResourceInput`
  discriminated type on the `defineResource` facade (`:140`).
- `plugins/framework/plugins/tooling/plugins/checks/plugins/keyed-resource-scope/check/index.ts`
  — new check (mirror `../no-db-backed-notify/check/index.ts`).
- `plugins/framework/plugins/tooling/plugins/checks/plugins/keyed-resource-scope/CLAUDE.md`
  — stub (the `plugins-have-claudemd` check requires it).
- Reuse, do **not** re-implement: `grepCode` (`checks/core`), `maskSource` /
  `findMarkerCalls` / `parseStringField` (`plugin-meta/parse-utils/core`).

## 6. Deferred follow-ups (file via `add_task` on approval)

- **Read-set ceiling diagnostic.** Surface, per keyed resource, any captured
  read-set table NOT in `coveredOrigins(R)` — the precise "table T silently FULLs
  you" signal — on the existing read-set debug pane
  (`plugins/debug/plugins/read-set`). Runtime-only (needs boot + traffic); the
  honest home for full read-set coverage. Show `coveredOrigins(R)` alongside the
  captured read-set so gaps are obvious.
- **Scheduler propagation.** When the work-admission scheduler lands, it must read
  `RegistryEntry.recompute` (and `identityTable`) to decide whether a FULL
  `RecomputeIntent` is a *declared* choice or a silent regression — `recompute` is
  already surfaced on `RegistryEntry` by Part A for exactly this. This is the
  budget layer (§6.3 of the work-admission model) that catches the read-set ceiling
  at runtime.
- **Derive `identityTable` from FK metadata** (source doc §4, optional) — removes
  the last hand-authored coupling.

## 7. Verification

- **Type (primary):** in a scratch edit, remove `identityTable` from
  `attemptsResource` (`tasks-core/.../resources.ts:76`) → `./equin build`
  type-check fails at that call site. Add `recompute: { kind: "full", reason: "…" }`
  instead → type-checks (FULL declared). Revert.
- **Check (backstop):** temporarily introduce a keyed `defineResource` with neither
  field via an `as any` cast that bypasses the type → `./equin check
  keyed-resource-scope` fails and names the offender. Revert → passes.
- **No regression:** `./equin check` passes wholesale on the unchanged tree
  (all three keyed resources already declare `identityTable`); the new check reports
  `ok` and `plugins-registry-in-sync` stays green after `build` regenerates the
  check registry.
- `./equin build` succeeds and the server boots (no behavioural change — the
  cascade still scopes exactly as `986d21ec1` shipped).
