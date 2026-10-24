# Parse boundaries state their input honestly: `ZodParser<T>`

## Context

Adding the `events.date` field surfaced a limitation already written down in
`plugins/fields/core/internal/field-spec.ts`: a zod schema carrying an inner
`.default()` cannot be used as a field schema. `RecurrenceRuleSchema.interval`
wanted `.default(1)`; it had to become `.optional()` with a `ruleInterval()`
normalizer standing in for it.

The cause is one line, and it is not specific to fields. In zod v3, `ZodType`
takes three parameters — `ZodType<Output, Def, Input>` — and `Input` **defaults
to `Output`**. So `z.ZodType<T>` means `ZodType<T, ZodTypeDef, T>`: a claim that
the value going *in* is already a `T`.

That claim is false at every boundary in this repo where a schema is used. A
field schema parses a jsonb column. An endpoint schema parses a request body. A
resource schema parses a WebSocket payload. In all three the input is untrusted
JSON — `unknown` — and every combinator that widens input relative to output
(`.default()`, `.catch()`, `.coerce`, `.transform()`, `.preprocess()`) is
excluded by it.

The constraint has been independently rediscovered and routed around **nine
times across seven plugins**:

| Where | Workaround |
|---|---|
| `apps/events/event-date` | `.optional()` + a `ruleInterval()` normalizer |
| `primitives/rank` | `z.union` instead of `z.preprocess`, plus `as unknown as` |
| `primitives/live-state` `tolerantEnum` | `z.union` + `as unknown as`, with a 10-line comment explaining why |
| `debug/profiling/runtime` | a dead `?? FLIGHT_WINDOW_MS_DEFAULT` in the handler |
| `debug/read-set` | `.optional()` where `.default([])` was wanted (×2) |
| `debug/health-monitor` | `.default(0)` avoided |
| `apps/workflows/engine` | "No zod `.default()` here" |
| `release` | `.optional()` rather than `.default()` |
| `stats/{cost,pushes,commits}` | "no `.default()`/`.transform()`/`.preprocess()`" |

### The failure has two modes, and only one of them is loud

**Loud** — assigning a wide-input schema to a `ZodType<T>` parameter errors on
`_input`. This is the reported bug.

**Quiet** — where a type *infers through* `ZodType<infer U>` rather than
accepting it as a parameter, a wide-input schema does **not** error. It silently
resolves `U` to the schema's **input** type: the one where defaulted fields are
optional. It looks like a real row type and disagrees with what `.parse()`
returns.

This is already live. `plugins/debug/plugins/profiling/plugins/runtime/shared/endpoints.ts:111`
defines a query schema with `.coerce`, `.default()` and a clamping `.transform()`.
`defineEndpoint`'s `query?: ZodType<TQuery>` infers `TQuery = { windowMs?: number | undefined }`,
so the handler is told the field may be missing. It never is —
`handle-flight-window.ts:5-8` already names the mechanism and writes dead code
around it:

```ts
// The schema defaults + clamps windowMs, but the query type is the schema's
// INPUT side where the field is optional — mirror the default for tsc.
const windowMs = query.windowMs ?? FLIGHT_WINDOW_MS_DEFAULT;
```

Two more inference sites have the same shape and are latent *only because the
loud failure currently prevents such schemas from existing*: `SpecType<S>`
(`endpoints/core/define-endpoint.ts:52-57`) and `EntityRow<E>`
(`entities/server/internal/types.ts:217`). **Fixing the loud mode unlocks the
quiet one**, so both must be repaired in the same change.

### Intended outcome

One named type for "a schema that parses untrusted input into `T`", used at
every parse boundary; the nine workarounds deleted; the live flight-window
mis-typing fixed; and a lint rule so the constraint is not re-derived a tenth
time.

## The type

```ts
export type ZodParser<T> = z.ZodType<T, z.ZodTypeDef, unknown>;
```

### What this does and does not give up

Verified against the repo's own zod (3.25.76) with a type-level probe, not
reasoned from memory.

**Unchanged.** Runtime validation is untouched. `ZodParser<T>` still pins
`Output = T` exactly: `.parse()` returns `T` and not `any`, member access stays
typed, and a schema with the wrong output is still rejected.

**Given up.** `Input` does two compile-time jobs — it types `z.input<S>` and it
checks the argument to `.default()`. Both go opaque on a value *annotated*
`ZodParser<T>`. In this change nearly every annotation is a **parameter**, so
the argument keeps its concrete type at the definition site and loses nothing:
`Concrete.default({ y: "nope" })` still errors, `z.input<typeof Concrete>` is
still precise. Only the interior of generic plumbing — whose entire job is
`.parse()` on untrusted JSON — sees `unknown`, which is the honest type there.

**The one property position.** `FieldDef.schema` is a property, so
`field.schema` becomes `ZodParser<T>` for everyone, which unguards
`field.schema.default(field.defaultValue)` in `fieldSchemaWithDefault`. zod
feeds a `.default()` value back through the inner parse, so it must be
input-typed; `defaultValue: T` still catches a plainly wrong default but stops
guaranteeing the default is re-parseable. That only bites a field schema with a
`.transform()`, of which there are none.

Typing `defaultValue` as `z.input<S>` to close it was measured and **rejected**:
the one-argument form `FieldDef<string>` (how ~40 sites are written) degrades
`defaultValue` to `unknown`, and `defaultValue` is read as a live `T` throughout
the repo — it seeds form values (`launch-options/web/internal/values.ts:11`,
`list-renderer.tsx:53`), it *is* the config value
(`config_v2/core/internal/define-config.ts:37`, `server/internal/registry.ts:560`),
and the CLI iterates `compositionsConfig.fields.manifests.defaultValue` as real
manifest items (`release.ts:256`). It stays output-typed; the residual risk gets
a comment on `fieldSchemaWithDefault`.

## Where it lives

`plugins/packages/plugins/zod-parser/` — `core/index.ts` only, alongside
`retry`, `semaphore`, `inflight`. Chosen over `primitives/` because
`resource-runtime` documents its own dependency policy at
`core/runtime.ts:34-37` as importing "only the `packages/…` leaves
(globally-allowed utility code, so no cycle)" — putting the alias there keeps
that import consistent with the rule it already states.

Boundary impact: `allow("plugin.** -> plugin.**")` in `boundary-config.ts`
already permits every plugin→plugin edge, so **no config change is needed**.
Add `allow("** -> plugin.packages.zod-parser")` only if a non-plugin caller
(`cli/`, a composition root) ends up needing it. No cycle is possible — the leaf
imports nothing but `zod`.

Two comments become stale and must be updated: `fields/core/internal/field-spec.ts`
("fields/core is the sink … so there is no cross-plugin import here") and
`resource-runtime/core/runtime.ts:34`.

## Implementation

### 1. The leaf plugin

`plugins/packages/plugins/zod-parser/` — `package.json`, `CLAUDE.md`,
`core/index.ts` exporting `ZodParser<T>` with a doc comment carrying the *why*
(the three-parameter shape, the `Input`-defaults-to-`Output` trap, and the two
failure modes).

### 2. Widen the parameter and property positions

`fields`
- `core/internal/field-spec.ts:26` — `schema: ZodParser<T>`. Delete the
  KNOWN LIMITATION block; replace with a short note on the `defaultValue`
  re-parse caveat.
- `core/internal/schema-builder.ts` — the declared shape `{ [K in keyof F]: F[K]["schema"] }`
  **stays**. It is now honest rather than a cast around a lie. Add the
  re-parse note to `fieldSchemaWithDefault`.
- `plugins/json/plugins/config/core/internal/json.ts:21` — `schema: ZodParser<T>`.
  This is the one caller-facing door for custom schemas, and the one
  `event-date` goes through.
- The `as unknown as z.ZodType<T>` casts in `object.ts:51`, `list.ts:69`,
  `variant.ts:45`, `enum-text.ts:21` — retarget to `ZodParser<T>`; several
  become unnecessary. Drop each cast that compiles without it rather than
  retargeting it blindly.

`primitives/live-state`
- `core/resource.ts:19,86,105,122` — the descriptor field and all three factories.
- `core/window.ts:84,130` — `elementSchema`.
- `core/resolvable.ts` — the four `ZodType` positions.
- `web/notifications-client.ts:797`. The existing `ZodType<unknown>` sites are
  already correct and just get the alias for consistency.

`framework/resource-runtime`
- `core/runtime.ts:213,434,531` — `ResourceDefinition`, `ResourceContract`,
  `Resource`. Update the acyclicity comment at line 34.

`infra/query-resource`
- `core/internal/descriptor.ts:44` and `core/internal/window-descriptor.ts:34,53`
  — `rowSchema: ZodParser<Row>`.

`infra/endpoints`
- `core/define-endpoint.ts` — `querySchema?: ZodParser<TQuery>` (18),
  `Spec<T> = ZodParser<T> | Codec<T>` (46), `query?: ZodParser<TQuery>` (69).
- `core/codec.ts:33` — `json<T>(schema?: ZodParser<T>)`.

### 3. Repair the two silent-inference sites

```ts
// endpoints/core/define-endpoint.ts:52-57
type SpecType<S> = S extends Codec<infer U> ? U
                 : S extends ZodParser<infer U> ? U : void;

// entities/server/internal/types.ts:217
type EntityRow<E> = E extends { schema: ZodParser<infer T> } ? T : never;
```

Probed: `ZodParser<infer U>` recovers the **output** type where `ZodType<infer U>`
recovered the input. `entities/core/internal/wire-schema.ts` keeps its
`F[K]["schema"]` shape unchanged.

### 4. Delete the workarounds

- `apps/events/event-date/core/internal/event-date.ts` — `interval: z.number().int().positive().default(1)`;
  delete `ruleInterval()` and its callers; update the comment and
  `event-date.test.ts:21-29`.
- `debug/profiling/runtime/server/internal/handle-flight-window.ts:5-8` —
  `const windowMs = query.windowMs;`, comment gone.
- `primitives/rank/core/internal/rank.ts:48-53` — `RankSchema: ZodParser<Rank>`,
  cast and comment gone.
- `primitives/live-state/core/tolerant-enum.ts:33-43` — signature to
  `ZodParser<T>`, cast gone; rewrite the paragraph that explains the union-over-
  `z.preprocess` choice, since the reason has been removed.

**Not in scope, deliberately.** The `.optional()`-instead-of-`.default()`
choices in `debug/read-set`, `debug/health-monitor`, `workflows/engine`,
`release` and `stats/{cost,pushes,commits}` are now *possible* to reverse, but
reversing them changes client-visible behaviour (missing becomes `[]`/`0`
instead of `undefined`). Fix only the comments, which now cite a constraint that
no longer exists; leave each schema for its owner to opt into.

### 5. The lint rule

`plugins/packages/plugins/zod-parser/lint/` — `index.ts` default-exporting
`{ name: "zod-parser", rules: { "no-narrow-zodtype": … } }`, following
`plugins/framework/plugins/tooling/plugins/lint/plugins/icon-safety/lint/`.
A non-tooling plugin owning a rule has precedent in
`plugins/primitives/plugins/pane/lint/no-hint-fabrication.ts`, which also shows
the `TSTypeReference` inspection this rule needs.

Rule: flag a `TSTypeReference` whose name is `ZodType` or `z.ZodType` carrying
exactly one type argument. Message: use `ZodParser<T>`, or spell all three
parameters when input genuinely equals output.

Two constraints. The rule file must be **self-contained** — no `@plugins/*`
imports, since jiti cannot resolve them in the ESLint config. And it lands
**last**, after the conversion, so it reports zero on a clean tree rather than
masking the work.

## Verification

```bash
./equin check type-check     # the primary gate — the whole design is a type change
./equin check                # boundaries, registry/doc sync, eslint incl. the new rule
./equin build
./equin test plugins/fields
bun test plugins/apps/plugins/events/plugins/event-date
```

The type-level behaviour is already proven; probes live in this session's
scratchpad and confirmed, against zod 3.25.76:

- a `.default()`-carrying schema is assignable to `ZodParser<T>` and not to `ZodType<T>`
- `z.infer` off `fieldsToZodObject` still yields the output row
- explicit-type-argument call sites (`resourceDescriptor<Song[]>(…)`) compile
- `.extend` / `.omit` / `.passthrough` results still flow into widened consumers
- `EntityRow` and `SpecType` recover the output type
- the flight-window query types as `number`, no `??` needed
- `tolerantEnum` and `RankSchema` compile as plain `z.preprocess` with **no casts**

Runtime spot-checks after `./equin build`, at
`http://att-1786117820-0e11.localhost:9000`:

1. **Events** — add a URL source, run a refresh, confirm a recurring event
   extracts and its interval renders. This exercises `.default(1)` actually
   parsing, which is the whole point.
2. **Debug → Slow Events** — hit the flight-window endpoint and confirm the
   default and clamp still apply now that the handler no longer mirrors them.
3. **Any tasks/mail list** — confirm a live-state resource still hydrates, since
   every descriptor's schema type changed.

## Risks

- **The conversion is broad but mechanical**, and `tsc` catches every miss —
  there is no silent-success path. The one exception is the two inference sites,
  which is exactly why they are repaired in step 3 rather than left.
- **`fields/core` gains its first cross-plugin import.** Justified by the
  packages-leaf policy, but it does end a stated property of that plugin. If
  that is unwanted, the fallback is to spell `z.ZodType<T, z.ZodTypeDef, unknown>`
  inline in fields — at the cost of the shared name, which is most of the value.
- **The lint rule will flag legitimate `ZodType<unknown>` sites.** Those are
  already equivalent to `ZodParser<unknown>`, so converting them is correct, not
  a suppression.
