# zod 3 → 4 migration plan

Task: task-1793079250-84skjw. Unblocks the `zod` hold (`package.json` `dependencyPolicy.holds`, `below: "4.0.0"`, reviewBy 2027-01-25) and the `@modelcontextprotocol/sdk` hold in `plugins/infra/plugins/mcp/package.json` (TS2589, suspected nested zod 4 beside our zod 3).

## Context

We are on zod 3.25.76. 1,114 files import `"zod"` (the v3 API). Only `infra/claude-cli/server/internal/run-claude-read-only.ts` (and its test) imports `"zod/v4"`, for `z4.toJSONSchema`.

Most of the code is plain schema-building and moves with a codemod. The real work is in about 8 clusters that read zod 3 **internals** (`_def`, `typeName`, `ZodEffects`, `instanceof Zod*`), and in a handful of **silent** v4 behaviour changes, where the code still type-checks but behaves differently at runtime.

Outcome: zod 4.x installed and both holds lifted. No v3-internal reads remain, and a lint rule keeps it that way, so the next zod major is a change to one plugin.

### End state

- **Only `packages/zod-introspect` knows zod internals.** Everything else uses zod's public API or the `SchemaNode` it returns.
- **Two permanent lint rules:** `no-zod-internals` and `no-zod-subpath`.
- **No `zod/vN` imports anywhere**, and exactly one `zod` entry in the web vendor set.
- **`ZodParser<T>` and `no-narrow-zodtype` are deleted, not adapted.** v4's `z.ZodType<T>` already defaults `Input` to `unknown`, so the footgun they guard against no longer exists. The 105 `ZodParser<` sites are codemodded to `z.ZodType<T>`, and no new version-insulating aliases are added.
- **`describeZod` is computed from `SchemaNode`**, so a zod upgrade cannot move a fingerprint.
- **Field defaults use v4 `.default`** (output-typed, matching `FieldDef.defaultValue`).
  - An invalid default is impossible: `defineField` asserts `schema.parse(defaultValue)` and fails at boot.
  - A field type with no meaningful default (uuid) has none; such a field must be required or nullable.
- **The storage decoder is skipped only when decoding would check nothing** (`isUncheckedBase`: a bare `z.string()` with no checks). That matches sql-column's promise of decoding on every read and every write.
- **Live params accept any value-preserving schema.** `.refine` is accepted; transforms, fills and rewrite checks are refused.
- **Absence is spelled.** A key that may be missing is `.optional()`; `z.unknown()` keys follow v4's semantics.

How this was researched:
- Four readers covered internals, the API sweep, the ecosystem, and zod 4 facts (from zod.dev and the 3.25.76 `zod/v4` source in main's `node_modules`).
- Three competing strategies were written, then judged.
- A completeness critic reviewed the result.

The winning strategy is "structural": one owned introspection primitive, and every semantic decision made on v3 before the flip. It borrows from the other two strategies:
- the "big-bang" trial-then-flip mechanics and its golden fingerprint test;
- the "incremental" plan's subpath ban and its audit checklist.

### Facts the plan relies on

Checked against 3.25.76's v4 tree unless marked otherwise.

- **Subpaths.**
  - 3.25 ships `zod/v4` (and `zod/v4/core`).
  - 4.x keeps shipping `zod/v3`, with no removal date. Subpaths "remain available forever".
  - v3 and v4 schemas do **not** compose: a v3 schema cannot sit inside a v4 `z.object`.
  - Shared `core/` schemas compose everywhere, so a per-plugin `zod/v4` rollout would need bridges at every boundary. We reject that.
- **Internals.**
  - `schema._zod.def.type` is a lowercase string discriminator, replacing `typeName`.
  - `.refine` / `.superRefine` add a check and keep the class; `ZodEffects` is gone.
  - `.transform` returns `pipe(in, transform)`, and `z.preprocess` returns `pipe(transform, schema)`.
  - Native enums fold into `ZodEnum` (`def.entries`), and `.brand` is type-only.
  - Size caps live in `_zod.bag.maximum` (length-equals sets min, max and length).
- **`.describe()` / `.meta()` clone with the *same* def object.** Mutating a def therefore tags the source schema too, so tags must be stamped by cloning (`clone({...def, key})`).
- **Registries / `.meta()` do not propagate through `.optional()` / `.nullable()` / `.default()`.**
  - Registries are per module instance.
  - list-bound's "tag rides the schema object" design (`markers.ts:8-14`) therefore stays: the tag goes on `_zod.def`, not in a registry.
- **v4 `instanceof` works across duplicate module copies** (`Symbol.hasInstance` over trait names).
- **`ZodType<Output, Input>`, with `Input` defaulting to `unknown`.**
  - The footgun `no-narrow-zodtype` exists for (v3's `Input` defaulting to `Output`) disappears.
  - `ZodTypeAny` survives as a deprecated alias.
- **Silent runtime changes that matter here:**
  - `.default()` short-circuits: it is output-typed and not re-parsed. `.prefault()` is the old behaviour.
  - Defaults apply inside `.optional()` object keys.
  - `z.record(enumKey, V)` is exhaustive.
  - `.uuid()` is RFC-strict (`z.guid()` is the loose form).
  - `.int()` means a safe integer, and `Infinity` is rejected.
  - Default error-message text is reworded, and some issue codes are renamed (`invalid_string` → `invalid_format`, …).
  - `z.unknown()` / `z.any()` object keys become *required* from 4.4.0 per the changelog. **Unverified on 4.6.7; resolve it in the trial.**
- **`drizzle-zod` is a dependency, but nothing imports it.** Remove it.

## Principles

1. **One owner of zod internals.** Only the new `packages/zod-introspect` reads `_def` / `_zod`. Consumers work on a repo-owned `SchemaNode` union, so a new zod kind is a `never`-switch compile error rather than a silent miss.
2. **Decide on v3.** Every behaviour change lands, tested, on 3.25 before the flip. The flip commit carries no decisions.
3. **No double codemod.** Imports stay `"zod"` throughout; no rewrite to `zod/v4` and back across 1,114 files.

## Phase 0: groundwork (on 3.25, 1–2 PRs)

1. **Remove `drizzle-zod`** from the root `package.json`.
2. **Record baselines:**
   - `./equin check type-check` wall time and memory;
   - the web-artifacts vendor set (`plugins/framework/plugins/tooling/plugins/web-artifacts/core/internal/vendors.ts`);
   - a golden snapshot of `describeZod` over every registered query contract;
   - the MCP `tools/list` JSON output.
3. **Add the lint rule `zod-introspect/no-zod-subpath`.**
   - It bans the `zod/v3`, `zod/v4`, `zod/v4/core`, `zod/v4/mini` and `zod/mini` specifiers.
   - Exemptions go in `exempt/index.ts`:
     - `sanctioned` for zod-introspect's own dual-version tests;
     - `debt` for `run-claude-read-only.ts` and its test, tagged with this task.

## Phase 1: the `zod-introspect` primitive (on 3.25, 1 PR, ~1k LOC with tests)

`plugins/packages/plugins/zod-introspect/core/` (next to `zod-parser` and `list-bound`):

- **`SchemaNode`: a discriminated union in the v4 model.**
  - It covers leaf kinds, `object { shape, unknownKeys }`, `array { element, max }`, `record`, `tuple`, `union`, `pipe { in, out }`, `transform`, and wrappers (`optional`, `nullable`, `default`, `prefault`, `catch`, `readonly`, `lazy`).
  - Checks are carried as `refine | rewrite | size`.
  - The v3 backend normalises into the same model:
    - a refine becomes a check;
    - a transform becomes `pipe(inner, transform)`, and a preprocess `pipe(transform, inner)`;
    - a brand is transparent;
    - a native enum becomes values;
    - passthrough, or an unknown/any catchall, becomes `unknownKeys: "opaque"`.
- **API:** `inspect(schema): SchemaNode`, `childrenOf`, `peel` (strips wrappers), and `valueSide(pipe)`.
  - `valueSide` takes `in` when `out` is a transform, else `out`.
- **`defineSchemaTag<T>(name)`:** set/get a namespaced tag, stamped **by clone**, never by mutation.
- **Backends:** `backend-v3.ts` and `backend-v4.ts`.
  - `backend-v4.ts` is an exhaustive switch over `z.core.$ZodTypes["_zod"]["def"]["type"]` with a `never` default, plus a runtime throw for unknown kinds.
- **Tests:** `describe.each([v3, v4])` with identical expected nodes. They pin the v4 facts above:
  - a tag survives `.max()`, `.describe()`, `.meta()` and `.check()`;
  - a tag is reachable through the wrappers, and does not leak to the source schema;
  - numeric-enum `entries`;
  - the overwrite-check shape.

## Phase 2: port the consumers onto `SchemaNode` (on 3.25, one PR each)

| # | Files | Change | Behaviour change |
|---|---|---|---|
| 2a | `packages/list-bound/core/internal/{walk,markers}.ts`, `walk.test.ts` | Walk `SchemaNode` instead of `typeName` strings. Tag through `defineSchemaTag`. An object counts as a list only when `unknownKeys` is a schema catchall, which closes the v4 trap where `.passthrough()` becomes a `catchall(unknown)`. | none |
| 2b | `network/live/core/internal/live-value.ts` (`findRefusedKind`, `listQuestionKind`, `zodTypeName`) | Refuse `transform`, the fill wrappers (`default`/`prefault`/`catch`) and `rewrite` checks. | `.refine` is now accepted (it doesn't change the value). Drop the `.refine` row in `live-value.test.ts`. |
| 2c | `infra/query-resource/server/internal/fingerprint.ts` (`describeZod`) | Serialise the normalised `SchemaNode`. Test `describeZod(v3 X) === describeZod(v4 X)`. Re-pin `fingerprint.test.ts` and `compile-alias.test.ts`. | **The fingerprint moves once.** It is part of every persisted live-state row's definition (`compile-alias.ts:600` → `resource-runtime` `definitionOf`), so every L2 snapshot recomputes cold. Ship this PR alone and watch boot catch-up. |
| 2d | `network/live/core/internal/field-domain.ts` | `peel` plus `valueSide`. Add cases for `tolerantEnum` and `z.coerce.date()` (expected "instant"). | none |
| 2e | `fields/plugins/{text,json}/plugins/storage/server/internal/storage.ts` | Skip the decoder only for `isUncheckedBase(schema)` (a bare `z.string()`, no checks), replacing `instanceof ZodString`. | Checked strings (`.min`, `.email`, `.refine`) now decode on read, at ~345 ns/value; on v3 they are skipped silently. |
| 2f | `infra/events/server/internal/dispatch-job.ts`, jobs `provider.ts`, `infra/entities/server/internal/define-entity.ts` (`splitNullability`), `infra/entity-extensions/core/internal/exposure.ts`, `fields/core/internal/{schema-builder,nullable}.ts`, `debug/profiling/runtime/core/endpoints.ts`, `stats/commits/shared/values.ts`, `apps/deploy/host-query/server/internal/*` | `inspect(...).kind` / `peel` in place of `_def` / `instanceof`. | none |
| 2g | `zod-introspect/lint/no-zod-internals` | No `_def`, `_zod`, `typeName`, `instanceof Zod*` (except `ZodError`) or `"Zod*"` kind literals outside the owner. This is the permanent guard. | none |

## Phase 3: v3-legal rewrites and silent-change fixes (on 3.25, small PRs)

1. **Shrink the version-specific type surface.**
   - Rewrite the three-argument `z.ZodType<…, z.ZodTypeDef, …>` sites to `ZodParser<T>`, so the flip has one alias to change.
   - In `infra/mcp/server/internal/mcp.ts`, `objectOutputType` becomes `z.output<z.ZodObject<T>>`.
   - No new aliases: whatever is left is fixed by tsc at the flip.
2. **Codemods** (ast-grep, then tsc):
   - one-argument `z.record(v)` becomes `z.record(z.string(), v)`;
   - `z.ZodIssueCode.custom` becomes `"custom"`.
   - Counts disagree (between 38 and 144 `z.record(` calls), so size the work from a tsc dry run, not from rg.
3. **Make message-pinned tests wording-independent** by asserting `code` / `path`, not text.
   - Files: hooktheory `section.test.ts`, conflict-agent `build-prompt.test.ts`, `boot-catch-up.test.ts`, outbox `drain.test.ts`, agent-thread `group-thread.test.ts`.
   - The sql-column / sql-projection error snapshots are owned rendering, so they are re-pinned at the flip.
4. **Defaults that are values, not stand-ins.**
   - `defineField` (and every field-type constructor) asserts `schema.parse(defaultValue)` at definition time, so an invalid default fails loudly at boot on either zod version.
   - The uuid field (`fields/plugins/uuid/.../uuid.ts:25-26`, `z.string().uuid()` with default `""`) gets no default unless one is given; its users become required or nullable.
   - Hand-audit the other defaults on schemas whose input and output types differ: `spawn-job.ts`, `mcp/.../status.ts`, `metrics/core/board.ts`, `sentinel/.../vitals.ts`, `callout-block.ts`, `tolerant-enum.ts`. Each must hold an output-valid value, so v4 `.default` is correct there.
5. **Data-compatibility audits** (read-only, results in the PR). No strategy covered these; the critic found them.
   - **Stored DB rows.** Pass every `parsedJson` / `parsedText` column's stored values through the v4 schema (`query_db` against main), because sql-column throws loudly and one bad row breaks a whole collection. The risky cases are stricter `.uuid()` (e.g. `collect-body.ts` pageview ids, `dispatch-job.ts`), `.int()` above 2^53, and `Infinity`.
   - **On-disk JSONC config.** Round-trip every config file in `~/.equin` (and main's) through the v4 schemas, via the `config_v2` `resource.ts` / `tier-logic.ts` safeParse paths.
   - **In-flight graphile job payloads** (`machine/` parse sites) whose schemas carry nested `.default`.
   - **Other sites:**
     - `.pick` / `.omit` / `.extend` on refined objects (`wire-schema.ts`, tag-tree `serve.ts`);
     - the two enum-keyed `z.record` sites (exhaustive, or `z.partialRecord`);
     - the bare `z.unknown()` / `z.any()` keys.

## Phase 4: the flip (trial branch, then one commit)

1. **Trial (unpushed).**
   - Bump to `"zod": "^4.6.7"` and run `nicoespeon/zod-v3-to-v4` plus tsc.
   - Run the full suite, including Phase 1's tests on real 4.6, which catches drift from 3.25's v4 core.
   - Resolve the `z.unknown()` required-key question.
   - Feed every v3-legal fix back into Phases 2–3 as its own PR, so the flip only contains what can't land earlier.
2. **The commit:**
   - Delete the zod hold. Retry the MCP SDK hold; if TS2589 persists, keep it and file a task.
   - Codemod `ZodParser<T>` → `z.ZodType<T>`, delete the `zod-parser` plugin and `no-narrow-zodtype`, and update the comments that cite them (the sql-column / sql-projection lint files).
   - Delete `backend-v3.ts`; a v3 schema now throws by name.
   - `cappedRecord` returns `ZodRecord`.
   - `schema-builder.ts:16` keeps `.default`; its comment about input-typed defaults is deleted.
   - `claude-cli` imports `"zod"`; drop its debt exemption.
   - Re-pin the sql error snapshots.
3. **Rollback:** revert one commit. Phases 0–3 are valid on v3, and fingerprints are identical on both versions, so a revert recomputes nothing.

## Phase 5: cleanup (optional, after soak)

- Keep `no-zod-internals` and `no-zod-subpath` permanently.
- Optional codemods for the deprecated forms:
  - `.passthrough()` → `z.looseObject`, and `.strict()` → `z.strictObject`;
  - top-level `z.email()` / `z.uuid()` and the other string formats;
  - `ZodTypeAny` → `ZodType`;
  - `ctx.addIssue` → `ctx.issues.push`.
- Move the side-channel `refine` of `page/table/core/table-block.ts` and `page/editor/core/define-block.ts` onto the schema: v4 `.refine` keeps `ZodObject`.

## Verification

- Every phase: `./equin check` (type-check, eslint including the new rules, plugin-boundaries) and `./equin test` on the touched plugins.
- Phase 1: the dual-version suite passes on both backends.
- Phase 2c: deploy alone with `./equin build`, then watch live-state-snapshot catch-up and boot time in the Timeline and Reports (`debug` skill).
- The flip:
  - full `./equin test` and `./equin check`;
  - `./equin build` with exactly one `zod` vendor entry and `web-artifacts:no-vendored-state-inlined` green;
  - the golden `describeZod` snapshot is byte-identical to Phase 0;
  - a smoke boot, which runs every list-bound walk and the live param parsers;
  - the MCP `tools/list` diff shows no difference (`.describe()` text still present);
  - type-check time no worse than the baseline +10%, otherwise stop and investigate.

## Risks

| Risk | Guard |
|---|---|
| The two backends normalise differently | The dual-version table tests plus the cross-version `describeZod` equality test |
| 4.6 has kinds 3.25's v4 core lacks | The exhaustive `never` switch, and the Phase 1 suite re-run in the trial |
| `.passthrough()` objects read as lists | The `unknownKeys` rule (2a) |
| `.refine` silently skips the column decoder | 2e |
| Defaults stop re-parsing | 3.4 plus `.prefault` at the flip |
| Stored rows or configs stop parsing | 3.5 audits before the flip |
| The fingerprint invalidates snapshots | One isolated, scheduled move (2c); the flip is proven neutral |
| A long-lived flip branch conflicts | The trial feeds the residue back into pre-flip PRs; at merge, rebase and re-run the codemod |

## Decisions (settled 2026-10-28)

1. Field defaults → v4 `.default` plus a definition-time validity assert; the uuid field has no default.
2. Storage decoder → skip only when `isUncheckedBase` holds.
3. Live params accept `.refine`.
4. The fingerprint becomes version-independent through `SchemaNode`. It moves exactly once, when 2c lands.
5. `z.unknown()` keys follow v4 semantics; `.optional()` only where absence is legitimate, decided per site in the trial.

## Implementation status

As of 2026-10-28, uncommitted in this worktree (not pushed, not deployed).

### What landed

- **The flip.** `zod` is `^4.6.7` in the root `package.json`. The zod hold is gone, and so is the `@modelcontextprotocol/sdk` hold. `drizzle-zod` is removed. No `zod/vN` import remains outside zod-introspect's own lint rule and tests.
- **One owner of internals.** `packages/zod-introspect` has a single backend, `backend-v4.ts`. `inspect()` refuses a zod 3 schema by name. `no-zod-internals` and `no-zod-subpath` are both permanent lint rules. `ZodParser` and `no-narrow-zodtype` are deleted.
- **Consumers ported onto `SchemaNode`:** list-bound, live params (`findRefusedKind`), `describeZod`, field-domain, text/json storage (`isUncheckedBase`), entities, events, jobs, fields.
- **Field defaults.** Defaults use v4 `.default`, and `defineField` asserts that each default parses. `defineDefaultlessField` covers uuid/json fields that have no meaningful default.

### Review-fix round (13 confirmed findings; 12 fixed, 1 needed no change)

1. **tag-tree PATCH wiped unnamed extras (bug).** In zod 4, `.partial()` over a defaulted field fills an absent key with its default. `fields/core` now has `fieldsToPatchSchema(fields, keys)`: each key is `.optional()` with no default-backfill, and unknown keys are refused (strict). `serveTagTree`'s `extraSchema` uses it.
   - Tests: `schema-builder.test.ts`, and a tag-tree `repo.test.ts` case where a rename with `extra: {}` keeps the stored `note`.
   - Audit: no other `.partial()` / `.optional()` wraps `fieldsToZodObject` output. The remaining `.partial()` calls are over plain `z.object`s with no defaults.
2. **Codecs were not blinded.** `SchemaNode`'s `pipe` gained `codec: boolean`, read from the def's `transform` function.
   - `describeSchema` marks a codec opaque as `a codec transform`.
   - `findRefusedKind` refuses it as a live param parser. This covers `z.codec` and `z.stringbool()`.
3. **Def fields `describeSchema` could not see.** These are now on the node and in the description:
   - record: `mode` and `partial`. `map` is now its own node, with `max`.
   - union: `inclusive` and `unionFallback`.
   - `template_literal`: `parts`, each part described recursively.
   - `function`: `input` and `output`.
   - every string format's `pattern`, and `url`'s `normalize`.

   Neither `parts` nor `input` / `output` is a child (`childrenOf` is unchanged), so walkers such as list-bound do not descend into a function signature or a piece of one string.
4. **`looseRecord` was counted as capped.** list-bound ignores the finite key set when `mode === "loose"`.
5. **The tag clone lost getters.** `v4WithTag` now copies the def by descriptor, as zod's `mergeDefs` does. A tagged default's fill is fresh on every parse again (tested in `tag.test.ts`).
6. **`z.url()` passed as a live param.** A format check now carries `rewrites` (true for `url`: it trims, and with `normalize` it returns `url.href`). `findRefusedKind` refuses a format that rewrites.
7. **A map's native cap was ignored.** The `map` node carries `max`, and the walk reads it with `nativeCap`, as it does for array and set.
8. **live CLAUDE.md, typed params.** Rewritten in zod 4 terms:
   - Refused: transform, preprocess, codec, `.default()`, `.prefault()`, `.catch()`, and any check that rewrites the value (`url` included).
   - Accepted: `.refine()`.
9. **text/storage CLAUDE.md.** It now documents the `isUncheckedBase` rule: only a bare `z.string()` keeps a plain `text` column. The test comment no longer uses zod 3 vocabulary.
10. **zod-introspect description.** It now says zod 4 only (a zod 3 schema is refused by name) and lists both lint rules. The docs were regenerated.
11. **`describeZod` comment and query-resource CLAUDE.md.** Both now state the real property: the description is read off `SchemaNode`, so a zod upgrade that keeps that model cannot move it. A zod 3 schema throws.
12. **Composers that read a defaultless field's default.** Two rungs:
    - **Type rung:** `fields/core` gained `DefaultedFields<F>`, which tsc uses to reject a defaultless field.
      - `objectField` requires its own `default` when any sub-field has none.
      - `listField`'s `itemFields` and `defineConfig`'s `fields` must all have defaults.
    - **Runtime rung:** `fieldDefaults(fields, composer)` is now the one seeding helper. It is used by `objectField`, `defineConfig`, list Add and event-source forms. It throws a `FieldDefaultError` that names the composer and the key, instead of "write the key".
    - The generic automation config helpers (`defineAutomationConfig` / `defineLaunchAutomationConfig`) check their `extra` fields with `DefaultedFields<X>`. tsc cannot resolve the generic merge, so they cast that merge to it.

### Deviations from the review's suggested fixes

- **`normalize: true` is described as data, not blinded.** It is zod's own fixed rewrite, fully stated by the param, so the description moves when it changes. Blinding it would refuse every persisted `url({ normalize })` decoder for no gain.
- **A custom `z.stringFormat(name, fn)` is a `refine` check beside its format, not opaque.** This matches the existing rule that a test function is data: it accepts or refuses a value and never changes one. A format built from a regex is described by its `pattern`.
- **Finding 13 (`plugins-doc-in-sync`) needed no change.** The check passes. zod-introspect's "Imported by" lists only `network/live` and `list-bound` because the cross-refs facet counts same-runtime imports only. A `server/` or `machine/` file importing a `core` barrel is filtered out by design (`cross-refs/facet`, the "same-runtime filter"). So the docs were not stale; the generator under-reports cross-runtime importers everywhere. That is a follow-up, not drift.
- **The compile-SQL golden was regenerated.** `describeSchema` now records format patterns and the `rewrites` flag, so four `definition` hashes in `network/live/server/testing/compile-sql-golden.json` moved. Nothing else in the fixture changed. Every L2 snapshot over a schema with a string format recomputes once, in the same deploy as the flip.

### Known follow-ups

- **Cross-runtime imports in "Imported by".** The cross-refs facet drops server→core and machine→core imports, so a reverse index such as zod-introspect's "Imported by" under-reports.
- **Event-source fields have only the runtime rung.** Their field records come from contributions, so tsc cannot see a defaultless one. `fieldDefaults` throws when the form opens.
- **Test pollution in batch runs.** `supervised-job`'s `builtin-ledger.test.ts` failed once in a batch run: the host service `database.migration-source` had no provider. It passes alone. Several tasks-core DB tests failed once in a batch run and pass alone. Neither failure touches this change.
- **Not exercised yet in this worktree:** the plan's flip verification. That covers `./equin build`, a smoke boot, the MCP `tools/list` diff, the type-check time baseline, and the live-state-snapshot catch-up after the fingerprint moves.
