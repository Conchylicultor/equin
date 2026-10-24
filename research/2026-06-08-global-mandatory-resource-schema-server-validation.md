# Mandatory resource schema + unconditional server-side validation

## Context

`defineResource` (the live-state primitive) treats `schema` as **optional** —
a leftover from the staged migration tracked in
`research/2026-04-29-global-resource-schema-validation.md`. Two consequences:

1. **No single guarantee.** A resource *could* be defined without a schema, so
   its loader output of any shape would be broadcast as-is. Nothing structurally
   guarantees every live-state payload matches a declared schema.
2. **Validation lives only on the client.** Today the server forwards the schema
   to the client descriptor and never parses anything itself; the browser
   `NotificationsClient`/`useResource` parse on receipt (and throw if no schema
   is registered). A malformed loader output is therefore caught late — only when
   a client happens to subscribe — instead of loudly at the source.

**Current reality (verified):** all 32 server-side `defineResource` call sites
and the 1 central one (`auth-state`) **already pass a schema**, including the
four flagged as suspect (build hash, edited-files, commits-graph, jsonl-events).
So no resource needs a *new* schema authored — the migration is complete at the
call-site level. The only remaining work is to (a) make the contract mandatory
at the type level, and (b) actually enforce it on the server.

**Intended outcome:** `schema` becomes required on every resource, and the
server parses every loader output against it at load time — unconditionally,
at a single chokepoint. A payload that violates its schema fails loudly (caught
by the existing loader-failure handling → reported / crash task → send skipped)
instead of being broadcast.

## Decisions (confirmed with user)

- **Scope:** mandatory schema **+** server-side load-time validation.
- **central-core:** apply the same symmetric change to both runtime copies now;
  file a **follow-up task** to unify the two copies into a shared parameterized
  resource-runtime later (deferred — see "Why not unify now").

### Why not unify now

`central-core/core/resources.ts:5-8` documents the duplication as deliberate v1
debt: "Mirror of server's resources.ts … consolidate into a shared package once
both runtimes have a few resources each." Since then `server-core`'s copy has
diverged into a **superset** (keyed delta sync, Layer 2 scoped recompute,
`withNotifyBatch`, runtime-profiler spans, `reportServerError`, the
`Resource.Declare` contribution); `central-core` is a strict subset. Unification
is feasible (the `WsData`/`WsHandler` types are already identical; only the
profiler / error-reporter / declare registrar differ and would be injected into
a `createResourceRuntime({ wrapLoad, reportError, declare })` factory in a new
`framework/plugins/<resource-runtime>/core`). But central currently has **one**
resource, so by the design doc's own criterion it is premature, and folding a
load-bearing refactor into this schema change muddies both. Deferred to a task.

> **Update (done):** the unification has since landed. Both runtimes now
> instantiate one shared `createResourceRuntime` factory in
> `plugins/framework/plugins/resource-runtime/core`, with server-core/central-core
> kept as thin facades. See
> `research/2026-06-08-global-unify-live-state-resource-runtime.md`.

## Changes

### 1. `plugins/framework/plugins/server-core/core/resources.ts`

- **Make `schema` required** on `ResourceDefinition<T,P>` (line 72) and
  `Resource<T,P>` (line 101): `schema?: ZodType<T>` → `schema: ZodType<T>`.
  Update the doc comment (lines 65-71) — drop "Currently optional during the
  staged migration", state it is required and validated server-side at load time.
- **Runtime guard** in `defineResource` (defense in depth, mirroring the existing
  `keyed`/`keyOf` guard at lines 211-214): `if (!def.schema) throw new Error(...)`.
- **Carry the schema into `RegistryEntry`** (the internal type, lines 131-158):
  add `schema: ZodType<unknown>`, populate it when building `entry` (lines
  239-259) from `def.schema`.
- **Validate at the single chokepoint — `timedLoad` (lines 167-173):** parse the
  loader result before returning it, so every server load path (sub-ack
  `handleSub`, push/keyed/scoped `flushNotifies`, HTTP fallback
  `handleResourceHttp`) is covered by one change:

  ```ts
  function timedLoad(entry, params, ctx) {
    return recordEntrySpan("loader", entry.key, async () => {
      const raw = await entry.loader(params, ctx);
      return entry.schema.parse(raw);
    });
  }
  ```

  - A failed `parse` throws inside the existing `try/catch` around every
    `timedLoad` call (e.g. lines 542-551, 766-772, 841-846), which already calls
    `reportServerError` and skips the send / returns a `sub-error`. This is the
    desired fail-loud behavior (and files a crash task per the
    crash-on-recoverable-errors convention).
  - **Keyed scoped (Layer 2) safety:** scoped loads return a *partial* array;
    parsing it against the `z.array(Element)` schema is still valid (an array of
    valid elements), so `diffKeyedScoped` is unaffected.
  - **Wire consistency:** broadcasting the *parsed* value matches what the client
    already does on receipt (same schema, same key-stripping/coercion), so this
    only moves the canonicalization earlier — no behavioral change for consumers.
- **Handle `load()` method** (lines 275-277): parse there too
  (`return def.schema.parse(await def.loader(params))`) so the one path that
  bypasses `timedLoad` is also covered. (Verified: no server consumers today,
  but keep the guarantee total.)

### 2. `plugins/framework/plugins/central-core/core/resources.ts`

Symmetric, smaller (no `timedLoad` wrapper — the loader is called directly at 3
sites + the handle):

- **Make `schema` required** on `ResourceDefinition` (line 38) and `Resource`
  (line 47); update the comment (lines 31-37); add the same runtime guard in
  `defineResource`.
- **Carry `schema` into `RegistryEntry`** (lines 57-68).
- **Add a small `loadValidated(entry, params)` helper**
  (`entry.schema.parse(await entry.loader(params))`) and route the three direct
  loader calls through it: `handleSub` (line 367), `flushNotifies` (line 240),
  `handleResourceHttp` (line 431). Parse in the handle `load()` (line 133) too.
- Failures are caught by the existing `try/catch` (central uses `console.error`;
  it has no error-reporter — acceptable, matches current central behavior).

### 3. Docs

- `plugins/primitives/plugins/live-state/CLAUDE.md` (lines 30-34): replace the
  "currently **optional** … will become **required**" paragraph with: schema is
  **required** and **validated on the server** at load time (single chokepoint),
  in addition to the client-side parse. Keep the escape-hatch note.
- `research/2026-04-29-global-resource-schema-validation.md`: add a short closing
  note that the migration is complete and schema is now mandatory + server-validated.

### 4. Follow-up task (not part of this change)

`add_task`: "Unify the duplicated live-state resource runtime (server-core +
central-core) into a shared parameterized `createResourceRuntime` primitive."
Reference this doc's "Why not unify now" section.

## Files to modify

- `plugins/framework/plugins/server-core/core/resources.ts`
- `plugins/framework/plugins/central-core/core/resources.ts`
- `plugins/primitives/plugins/live-state/CLAUDE.md`
- `research/2026-04-29-global-resource-schema-validation.md` (closing note)

No resource definition files change (all 32 + 1 already pass a schema). No
client-side change (`ResourceDescriptor.schema` is already required).

## Verification

1. `./equin build` — TS compiles across all plugins. Making `schema`
   required is the static safety net; if any call site lacked one it would now
   be a compile error (verified: none do).
2. **Happy path:** open `http://<worktree>.localhost:9000`, exercise live
   surfaces (tasks list, conversations sidebar, task events, build history,
   commits graph, jsonl viewer) and confirm data renders — i.e. server-side
   parse round-trips every payload without throwing.
3. **Fail-loud path:** temporarily make one loader return a value that violates
   its schema (e.g. a wrong-typed field), rebuild, subscribe, and confirm the
   server logs/report fires and the send is skipped (sub-error / no broadcast)
   rather than shipping the bad payload. Revert.
4. **HTTP fallback:** `curl http://<worktree>.localhost:9000/api/resources/<key>`
   for a couple of keys — confirm `{value, version}` returns parsed/valid data.
5. **central:** confirm the `auth-state` resource still drives the Accounts UI
   (central path: `/ws/central-notifications`).
