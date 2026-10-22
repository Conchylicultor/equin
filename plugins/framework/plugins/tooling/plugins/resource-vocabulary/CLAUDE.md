# resource-vocabulary

The closed set of ways a plugin declares a live-state resource — descriptor
factories and register markers — as data every build-time resource scanner reads.

## The list is derived, not authored

**Nothing about a name is inspected.** The key set comes from the barrels' own
module types, filtered by return type:

- `core/` — `resourceDescriptorFactories satisfies Record<MintingFactoryName,
  DescriptorFactory>`, where `MintingFactoryName` is every export of
  `live-state/core`, `query-resource/core` and `network/live/core` returning a
  resource descriptor (matched on `key` + `schema`, the two fields every
  descriptor carries; `live-state/core` exports none any more) — or a collection (matched on `rows`, the point
  descriptor every form mints — window, lookup-only, `all`, union — i.e.
  `liveCollection`).
  Add a factory to any of those barrels and omit it here → `tsc` fails with the
  missing key named. Delete or un-export a factory → the stale entry fails as an
  excess property. Only an EXPORTED factory is a way to declare a resource: the
  window / point factories `liveCollection` is built on are internal to
  `network/live`, so they are not listed — a scanner sees their resources
  through `liveCollection`'s `mints`.
- `check/` — the same derivation for the register markers, over `server-core/core`,
  `query-resource/server` and `network/live/server` (a served resource — including
  `serveValue`'s `ServedValue` — or a served collection, matched on `rows` —
  `serveCollection`). It lives there rather than in `core/` because
  runtime isolation grants `core -> core` only. Its `run()` half checks the one
  thing types cannot see: that each entry's `barrel` really exports it (that field
  is read only by scanner error messages, so nothing else would notice it rot).

Do not replace this with a hand-written list. Two scanners each kept one, they
disagreed, and neither learned about the bounded-membership factories — so ~10
plugins' resources vanished from `docs/plugins-details.md` and a preloaded
bounded descriptor could not pin its plugin eager. An unrecognised factory
produces no match and therefore no data, which reads exactly like a plugin that
declares nothing, so nothing failed.

## Serving primitives: classified, never matched

A `core` barrel may also export a function that SERVES a declaration on a
runtime its caller passes — `serveValueOn(rt, value, …)` and
`serveCollectionOn(rt, collection, …)` in `network/live/core`, the one serving
code path the Bun server, central and a browser server wrap. A served value
carries `key` + `schema` too, so the factory filter excludes every function
returning a served shape (`ServedResource`: `key` + `mode` + `load`, which no
descriptor has), and the same derivation lists those functions in
`resourceServingPrimitives` (`satisfies Record<ServingPrimitiveName, …>`, both
directions). A serving primitive mints nothing (the declaration is its
argument) and is not a register marker (its first argument is a runtime, not a
descriptor), so no scanner matches it: a host's resources are seen through that
host's own marker (`serveValue` / `serveCollection`). The `check/` run half
verifies its `barrel` like every other entry, and its register-marker
derivation reuses the same `ServedResource` / `ServedCollection` shapes.

## Consumers

- `plugin-meta/facets/plugins/resources` — the docs facet.
- `framework/tooling/codegen/core/eager-tier-gen.ts` — preload pins.

## One preload spelling

Every factory spells "hydrate before first paint" the same way: a `preload:`
field whose literal is `"boot"` or `"boot-and-keep"` (both preload; the second
only adds a client-side resident cache) or `"none"`. `PreloadFlag` records the
field and the two value sets; a scanner throws on a non-literal or any other
value.

## One call, several keys

Each factory entry lists what one call `mints`: `{ suffix, keyed, membership }`
per runtime resource. A plain factory mints one (suffix `""`);
`liveCollection("k", …)` mints `k` (window), `k:rows` (point) and `k:groups`.
Scanners emit one resource per minted entry, so the docs show every key, and a
register marker whose first argument names a collection (`serveCollection`)
serves all of them. An entry with `requires: "<field>"` is minted only when the
call's spec sets that field: a `liveCollection` without `default` is
lookup-only and mints `k:rows` alone, and one declared `all` mints `k` as the
whole ordered set (`requires: "all"`, `membership: null`, preloadable) and
`k:rows` — two mints of suffix `""`, never both kept. `unless: "<field>"` is
the complement (minted only when the spec does NOT set it), and a dotted field
(`paged.meta`) is read inside the spec's inline object of that name: a
`liveValue` mints a plain `k` unless it is declared `paged`, when `k` is its
pages — a keyed window (D3 of
`research/2026-10-11-global-live-paging-unification.md`), never preloaded —
plus `k:meta` when `paged` sets `meta`.

**`mintsOf(entry, argsText, where)` is the one reading of `requires`** (A28 of
`research/2026-10-01-global-scoped-change-routing-p5-p8-v2.md`), used by both
scanners — the docs facet's index and the eager-tier generator's preload scan
(which once ignored `requires`, and would have pinned `k` twice). It reads a
field's PRESENCE at the spec's own depth (the call's second argument; an
`all:` inside a row schema or a filterable column is not the spec's), and
throws, naming file and line, when two kept mints share a key — a spec setting
both `default` and `all`. It also throws rather than guess "absent" when the
text cannot say: a spec that is not one inline object literal (an identifier
`spec`, a wrapper call `makeSpec({ … })`, `{ … } as const`), a spread at the
spec's own depth (`{ ...base }` may carry `all`), or a `requires` field written
as a shorthand property (`{ row, all }`) — and the same of each object a
dotted field is read through, which must itself be an inline object literal —
a wrong "absent" drops the key from the docs and from the eager tier. A
factory with no conditional mint never reads its spec. `core/mints.test.ts`
cross-checks it against what `liveCollection` and `liveValue` really
register, for every form (window, lookup-only, `all`, union; plain, paged,
paged with `meta`).

Deliberately NOT rewired: `keyed-resource-scope` and `no-db-backed-notify`. Each
names its markers on purpose, to ban one shape: `keyed-resource-scope` a keyed
`defineResource` not declared through a shared descriptor (or missing its scope
policy), `no-db-backed-notify` a `db.` read inside an external
loader (`defineExternalResource`, or `serveValue` with `source: "external"`).

`isResourceVocabularyOwner(dir)` answers what both scanners need: inside
`live-state` / `query-resource` / `network/live` a factory call is the wrapper *implementing* it
(computed key), not a resource declaration. Everywhere else the key must be a
literal at the call site — a scanner reading source text has no other way to see
it, so both scanners throw rather than guess.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: The closed set of ways a plugin declares a live-state resource, as data every build-time resource scanner reads. Its key set is DERIVED from the barrels' own module types, so a factory that exists but is unlisted is a type error.
- Core:
  - Uses:
    - `plugin-meta/parse-utils.findImports`
    - `plugin-meta/parse-utils.hasField`
    - `plugin-meta/parse-utils.lineAt`
    - `plugin-meta/parse-utils.markerCallSpans`
    - `plugin-meta/parse-utils.maskSource`
    - `plugin-meta/parse-utils.matchBracket`
    - `plugin-meta/parse-utils.parseBoolField`
    - `plugin-meta/parse-utils.parseStaticCallId`
    - `plugin-meta/parse-utils.parseStringField`
    - `plugin-meta/parse-utils.unresolvableCallIdMessage`
  - Exports (types):
    - `DescriptorFactory`
    - `DescriptorFactoryName`
    - `DescriptorInfo`
    - `DescriptorShapeIsWidening`
    - `FileBindings`
    - `ImportedDescriptorResolver`
    - `MintedResource`
    - `PreloadFlag`
    - `RegisterCallTarget`
    - `RegisterMarker`
    - `RegisterMarkerName`
    - `ResourceMembership`
    - `ServedCollection`
    - `ServedCollectionFnNames`
    - `ServedResource`
    - `ServedResourceFnNames`
    - `ServingPrimitive`
    - `SourceFile`
  - Exports (values):
    - `buildDescriptorIndex`
    - `isResourceVocabularyOwner`
    - `LIVE_CORE`
    - `LIVE_SERVER`
    - `LIVE_STATE_CORE`
    - `mintsOf`
    - `parseFileBindings`
    - `QUERY_RESOURCE_SERVER`
    - `registerCallTarget`
    - `resourceDescriptorFactories`
    - `resourceRegisterMarkers`
    - `resourceServingPrimitives`
    - `resourceVocabularyOwnerPaths`
    - `SERVER_CORE`
- Cross-plugin:
  - Imported by: `framework/tooling/codegen`

<!-- AUTOGENERATED:END -->
