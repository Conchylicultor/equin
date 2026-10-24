# One resource-declaration vocabulary, and a loud failure when a scanner meets a factory it doesn't know

## Context

Ten-ish plugins serve a live-state resource that the generated docs claim they don't.
`notifications`, `pages/starred`, `pages/agent-origin`, `conversation-category`,
`conversation-preprompt`, `conversation-progress`, `conversation-view/notes`,
`conversations-view/queue`, `usage-rank` and `tasks/auto-start` each render a
`- Server:` block in `docs/plugins-details.md` with no `Resources:` line under it.
Agents read that file to find existing helpers before writing new ones, so a resource
that is invisible there is a resource that gets rebuilt.

The cause is a hardcoded name list. `plugins/plugin-meta/plugins/facets/plugins/resources/facet/parse-resources.ts`
recognises a resource by matching literal identifiers: `DESCRIPTOR_FACTORIES` holds three
names, `REGISTER_MARKERS` holds three more. The real vocabulary is eight descriptor factories
and four register markers:

| kind | exported from | names |
|---|---|---|
| descriptor factory | `live-state/core` | `resourceDescriptor`, `keyedResourceDescriptor`, `centralResourceDescriptor`, `windowResourceDescriptor`, `pointResourceDescriptor` |
| descriptor factory | `query-resource/core` | `queryResourceDescriptor`, `windowQueryResourceDescriptor`, `pointQueryResourceDescriptor` |
| register marker | `server-core/core`, `central-core/core` | `defineResource`, `defineExternalResource` |
| register marker | `query-resource/server` | `queryResource`, `windowQueryResource` |

The facet knows 3 of 8 factories and 3 of 4 markers.

**The blind spot is not confined to docs.** `plugins/framework/plugins/tooling/plugins/codegen/core/eager-tier-gen.ts:213`
keeps a *second, independent* copy of the same list — and the two disagree: eager-tier-gen
knows `centralResourceDescriptor`, the facet doesn't; neither knows the five bounded ones.
That scanner decides which app-content plugins stay in the eager boot tier because they
declare a `bootCritical: true` resource. A `windowQueryResourceDescriptor(…, { bootCritical: true })`
inside `apps/plugins/**` is invisible to it, so the plugin is deferred, its descriptor is
not registered before the boot snapshot hydrates, and the surface paints a pending state it
was designed never to show. Today only `shell/plugins/notifications` sets `bootCritical: true`
through a bounded factory, and `shell/**` can never be deferred — so this one is latent, not
live. It is the same defect, one commit away from biting.

**Why nothing noticed.** An unrecognised factory produces no match and therefore no facet
data — byte-identical to a plugin that genuinely declares nothing. `plugins-doc-in-sync`
re-renders from the same scanner and compares, so it agrees with the blind spot and passes.
Both failure modes are the empty result the repo's own rules forbid: a scanner that cannot
classify its input returns "nothing here" instead of failing.

Two corrections to the premise worth recording:

- `pushes-by-attempt` is **not** affected. It is a hand-written `keyedResourceDescriptor` +
  `defineResource(descriptor, { identityTable: "pushes" })` (`tasks-core/core/resources.ts:84`,
  `tasks-core/server/internal/resources.ts:157`) — bounded in effect, but on the legacy
  spelling the facet already recognises. It is documented today.
- `auth`'s central resource is also fine: it registers through the flat
  `defineExternalResource({ key, mode })` form, which the facet resolves inline.

**Intended outcome.** One declaration of the resource-declaration vocabulary that both
scanners read, whose completeness `tsc` enforces against the barrels themselves, and a scanner
that throws — naming file, line and expression — when it reaches a resource-serving call it
cannot resolve. Adding a ninth factory tomorrow should be either automatically covered or a
compile error, never a silent omission.

## Design

### 1. The vocabulary, with completeness enforced by `tsc` (rung 2)

New leaf plugin: `plugins/framework/plugins/tooling/plugins/resource-vocabulary/core/`.
It lives under `tooling` because both consumers are build-time scanners, and `plugin-meta`
already imports `tooling` (`facets/core/load-facets.ts` → `tooling/collected-dir/core`), so
this direction of edge exists. It contains data only — no runtime imports, only *type* imports.

The list is not authored free-hand; its key set is **derived from the barrels' own module
types** and filtered by return type, so a factory that exists but is unlisted is a type error:

```ts
import type { ResourceDescriptor } from "@plugins/primitives/plugins/live-state/core";

type LiveState = typeof import("@plugins/primitives/plugins/live-state/core");
type QueryRes  = typeof import("@plugins/infra/plugins/query-resource/core");

/** Every export of `M` that is a function returning a resource descriptor. */
type FactoryNames<M> = {
  [K in keyof M]: M[K] extends (...a: never[]) => ResourceDescriptor<never, never> ? K : never;
}[keyof M];

type DescriptorFactoryName = FactoryNames<LiveState> | FactoryNames<QueryRes>;

export const resourceDescriptorFactories = {
  resourceDescriptor:            { keyed: false, membership: null },
  keyedResourceDescriptor:       { keyed: true,  membership: null },
  centralResourceDescriptor:     { keyed: false, membership: null },
  windowResourceDescriptor:      { keyed: true,  membership: "window" },
  pointResourceDescriptor:       { keyed: true,  membership: "point"  },
  queryResourceDescriptor:       { keyed: true,  membership: null },
  windowQueryResourceDescriptor: { keyed: true,  membership: "window" },
  pointQueryResourceDescriptor:  { keyed: true,  membership: "point"  },
} as const satisfies Record<DescriptorFactoryName, FactoryEntry>;
```

`Record<DescriptorFactoryName, …>` requires **every** derived name as a key. Export a new
factory from either barrel and omit it here and `type-check` fails at this file with the
missing key named. No name-shape heuristic is involved: membership in the set is decided by
the return type. Note the filter naturally excludes `resourceDescriptorByKey`, whose return
type is `ResourceDescriptor | undefined` and therefore not assignable.

Do the same for the register markers over `server-core/core` and `query-resource/server`,
filtered on "returns a `Resource`". `defineResource`/`defineExternalResource` are overloaded,
so a conditional type resolves against the last signature — verify this at implementation
time. **If TS cannot express the register half cleanly, fall back one rung** for that half
only: a `resource-vocabulary-complete` check that reads each barrel's exports via
`parseBarrelExports` (already in `parse-utils/core`) and fails on any export that is neither
classified as a marker nor in an explicit `notResourceVocabulary` list. Do not skip
enforcement on the register half — that is where `windowQueryResource` went missing.

Each entry also carries the barrel specifier it comes from, which the loud-failure rule below
uses to tell "a descriptor identifier I should have resolved" from "a runtime value I
legitimately cannot".

### 2. Both scanners read the vocabulary; both hardcoded copies are deleted

- `plugins/plugin-meta/plugins/facets/plugins/resources/facet/parse-resources.ts` — replace
  `DESCRIPTOR_FACTORIES` and `REGISTER_MARKERS` with the imported vocabulary. The existing
  descriptor-index / import-alias / flat-form machinery stays as-is; only the name source changes.
- `plugins/framework/plugins/tooling/plugins/codegen/core/eager-tier-gen.ts:213` — replace its
  `DESCRIPTOR_FACTORIES` with the same import. Its `scanBootCriticalKeys` then sees bounded
  `bootCritical: true` declarations, closing the latent eager-tier hole.

Leave `keyed-resource-scope` and `no-db-backed-notify` alone. Each deliberately names one
marker to ban one shape; routing them through a "here is every way to declare a resource" list
would blur what they forbid.

### 3. Unresolvable ⇒ throw, not empty (rung 4)

Mirror the established precedent: `scanDataViewIds`
(`codegen/core/data-views-gen.ts:63-85`) throws via `parseStaticCallId` +
`unresolvableCallIdMessage` from `parse-utils/core`, and the `contributions` facet throws
rather than under-report. Two new throw sites, both using `unresolvableCallIdMessage` so the
message shape is uniform (where / what / what to do):

- **Descriptor factory with a non-literal key.** In `buildDescriptorIndex`, switch from the
  local `firstStringArg` regex to `markerCallSpans(maskSource(src), factory)` +
  `parseStaticCallId(src, span)`, and throw on a `dynamic` / `absent` result. This also aligns
  the facet with the sanctioned read-by-offset pattern it currently bypasses.
- **Register call whose descriptor argument doesn't resolve.** `resolveRegisterCall` returns
  `null` today for any unresolved identifier. Split that case in two:
  - the identifier is **imported from an `@plugins/…` specifier, or is a module-level `const`
    in this plugin** → throw. This is exactly the "a factory this scanner doesn't know minted
    it" case, and the message should say so: *"`agentPagesDescriptor` is not a descriptor this
    scanner can resolve — if it comes from a new descriptor factory, add it to
    `tooling/resource-vocabulary`."*
  - the identifier is neither (a function parameter) → still `null`. This is the one
    legitimate shape: the generic wrapper inside `query-resource/server/internal/compile.ts`
    calls `defineResource(descriptor, …)` where `descriptor` is a parameter. Keep that
    exemption narrow and comment it at the site.

The throw runs inside `./equin build`'s docgen and inside `./equin check
plugins-doc-in-sync`, so it is a hard stop at the offending file:line, not a report.

### 4. Membership reaches the docs

Once recognised, a window and a point resource both read `(keyed)` — indistinguishable from
the legacy unbounded keyed form the bounded contract
(`research/2026-07-18-global-bounded-working-set-resource-contract.md`) is migrating away from.
Since that contract is the documented default for new work, the docs should show which
membership a resource has.

Add `membership?: "window" | "point"` to `ResourceDef`
(`facets/plugins/resources/core/types.ts`), carried from the vocabulary entry of whichever
factory minted the descriptor. Then update, in order:

- `core/to-comparable.ts` — `` `${key} (${mode})` `` → append `, ${membership}` when present.
- `facet/index.ts` `renderDoc` — same suffix, so docs read `` `notifications` (keyed, window) ``.
- `plugins/render-detail/web/components/resources-detail-section.tsx` — render membership
  beside the existing mode span.
- `plugins/render-contributions/web/resources-facet-table.tsx` — add it to the Mode cell (or a
  narrow column); `ResourceRow` already carries `mode`, so this is additive.
- `plugins/render-diff/web` — check whether it renders `mode` directly or goes through
  `resourcesToComparable`; only the former needs an edit.

`membership` is optional, so a push or plain-keyed resource renders exactly as it does today
and only the newly-visible rows change.

### 5. Tests

Extend the two existing suites rather than adding new files:

- `facets/plugins/resources/facet/parse-resources.test.ts` — a `windowQueryResourceDescriptor`
  + `windowQueryResource` pair resolves with `membership: "window"`; a
  `pointQueryResourceDescriptor` resolves with `"point"`; an unresolvable **imported**
  descriptor identifier throws; a function-parameter descriptor still yields `null`.
- `codegen/core/eager-tier-gen.test.ts` — a `bootCritical: true` declared through
  `windowQueryResourceDescriptor` pins its app-content plugin eager.

Run with `./equin test plugins/plugin-meta/plugins/facets/plugins/resources` and
`./equin test plugins/framework/plugins/tooling/plugins/codegen`.

## Files

| file | change |
|---|---|
| `plugins/framework/plugins/tooling/plugins/resource-vocabulary/core/index.ts` (new) | the vocabulary, key set derived from the barrels' module types |
| `plugins/framework/plugins/tooling/plugins/resource-vocabulary/package.json`, `CLAUDE.md` (new) | plugin boilerplate; prose says why the set is derived, not authored |
| `plugins/plugin-meta/plugins/facets/plugins/resources/facet/parse-resources.ts` | read the vocabulary; span-based key read; two throw sites |
| `plugins/plugin-meta/plugins/facets/plugins/resources/core/types.ts` | `membership?: "window" \| "point"` on `ResourceDef` |
| `plugins/plugin-meta/plugins/facets/plugins/resources/core/to-comparable.ts`, `facet/index.ts` | render membership |
| `plugins/plugin-meta/plugins/facets/plugins/resources/plugins/render-{detail,contributions,diff}/web/**` | show membership |
| `plugins/framework/plugins/tooling/plugins/codegen/core/eager-tier-gen.ts` | drop its copy, read the vocabulary |
| `docs/plugins-details.md`, `docs/plugins-compact.md`, per-plugin `CLAUDE.md` | regenerated by the build |

Reuse, don't rewrite: `parseStaticCallId`, `unresolvableCallIdMessage`, `markerCallSpans`,
`maskSource`, `parseBarrelExports`, `findImports` — all already exported from
`@plugins/plugin-meta/plugins/parse-utils/core`.

## Verification

1. `./equin check type-check` — the derived `Record` compiles, and deliberately deleting
   one vocabulary entry must fail here with that key named. Do this deletion once, on purpose,
   to prove the enforcement is real; a `satisfies` that silently passes is the whole bug again.
2. `./equin check plugin-boundaries` — confirms the new `tooling → live-state/core`,
   `tooling → query-resource/core` type-only edges introduce no cycle.
3. `./equin build` (background) — regenerates docs. Then confirm the previously-blank
   plugins now carry a `Resources:` line with membership, e.g.
   `` `notifications` (keyed, window) ``, `` `starred-pages` (keyed, window) ``,
   `` `conversation-categories` (keyed, point) ``:
   ```bash
   rg -n "Resources: .*(window|point)" docs/plugins-details.md
   rg -n "Resources" plugins/shell/plugins/notifications/CLAUDE.md \
                     plugins/apps/plugins/pages/plugins/starred/CLAUDE.md
   ```
4. `./equin check plugins-doc-in-sync` — passes against the regenerated files.
5. `./equin test` for the two suites above.
6. Loud-failure smoke test, reverted immediately: temporarily rename a descriptor factory in
   the vocabulary so a real call site becomes unresolvable, run `./equin check
   plugins-doc-in-sync`, and confirm the error names the offending file, line and identifier
   rather than dropping the resource. Revert.
7. Studio → Contributions → Resources table and a plugin detail pane at
   `http://att-1787253943-p9nm.localhost:9000/studio` show the newly-visible resources with
   their membership.

## Follow-up worth filing separately

`docs/plugins-details.md` is read by agents as the reuse index, and this is the second class of
silent under-reporting in it (the first was the `contributions` facet's early-read, fixed with
a throw). Every remaining static facet — `routes`, `db-schema` — recognises its subject by a
hardcoded marker name with a silent-drop fallback, so the same defect is available there. A
follow-up task should decide whether "unclassifiable input ⇒ throw" becomes the default
contract for `createFacet`'s static extractors rather than a per-facet choice.
