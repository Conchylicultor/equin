# config_v2

See [config v2 vision](../../research/2026-05-16-config-v2-vision.md) for the
full design rationale, planned field types, and storage model.

## Declaring config (plugin author)

```ts
import { defineConfig } from "@plugins/config_v2/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { listField } from "@plugins/fields/plugins/list/plugins/config/core";

export const myConfig = defineConfig("my-plugin", {
  fields: {
    enabled: boolField({ label: "Enabled", default: true }),
    name: textField({ label: "Display name" }),
    items: listField({
      label: "Items",
      itemFields: {
        title: textField({ label: "Title" }),
      },
    }),
  },
});
```

Each field carries its Zod schema, default value, and UI metadata; the settings pane
renders them automatically. Field types live under `plugins/fields/plugins/`; see
[fields/CLAUDE.md](plugins/fields/CLAUDE.md) to add new ones.

## Reading config

**Web:** `useConfig(myConfig)` returns reactive values that update live. It answers the
(normally unreachable) window where the document is not known yet with
`descriptor.defaults` — fine for a cosmetic read, WRONG whenever the value decides what the
surface asserts (which views/items exist, whether a mode is on): defaults are a legitimate
answer, so a consumer cannot tell "the user configured nothing" from "we don't know yet".
Those reads use **`useConfigResult(myConfig)`**, which returns live-state's
`ResourceResult` (`status: "loading" | "error" | "ready"`) and makes the unknown window a
state to render (`live-state/no-pending-data-collapse` lints the collapse). Both live values it
reads (`configValues`, `configScopes`) are `preload: "boot-and-keep"`: every document a first
paint can read rides the boot snapshot and is never evicted, so `loading` after a successful
boot is unreachable rather than merely rare.

**Server:** `getConfig(myConfig)` reads the current value from the in-memory
cache. `watchConfig(myConfig, cb)` notifies on changes.

## Descriptor provenance (`source`)

Every `ConfigDescriptor` carries a `source: "manual" | "reorder" | "view"`, set by
`defineConfig` (defaults to `"manual"`), distinguishing **hand-authored** configs from
the two **auto-generated** families — one descriptor per reorderable render slot
(`reorderDirectiveDescriptor`) and one per DataView consumer (`viewsDescriptor`). Named
`source`, **not `origin`**: `origin` already means the `.origin.jsonc` layer here.

`source` lives on the descriptor object only — **not** in the config document or schema,
so it never affects an origin `@hash` or `config-origins-in-sync`; the settings config nav
surfaces it as a filterable `enum`. A new primitive that generates descriptors must give
itself its own `source` value.

## Three-layer config model

Config flows through three layers, each with a human-editable override mechanism:

```
Code (defineConfig)  →  git config/  →  ~/.singularity/state/config/
   defaults + schema      repo defaults     user config
```

### Layer 1: Code → git (build-time)

`./singularity build` generates `config/<plugin-tree>/<name>.origin.jsonc` from `defineConfig` defaults. First line: `// @hash <12-hex>` (content hash).

**Agent overrides:** Copy to `config/<plugin-tree>/<name>.jsonc`, edit values, keep the `// @hash` line from origin.

**Conflict detection:** when origin regenerates with a new hash, `config-origins-in-sync` fails on any `.jsonc` override still referencing the old one. Review the origin change, update the override, restamp `// @hash`.

### Layer 2: git → user (build-time)

`./singularity build` propagates the resolved git config (override if present, else origin) to `~/.singularity/state/config/<plugin-tree>/<name>.origin.jsonc` with a hash of the source content. The server reads from this directory at startup without re-propagating.

**User overrides:** UI `setConfig` or manual edits create `~/.singularity/state/config/<plugin-tree>/<name>.jsonc` with the origin's content hash.

**Conflict detection:** When git config changes, the propagated origin hash updates, and a user override still carrying the old hash becomes a **conflict**: the new git value takes effect, and the settings UI surfaces the conflict (Keep / Accept / Merge) — see [Conflict precedence](#conflict-precedence-origin-wins-until-reconciled). A user override therefore never silently masks a committed change; it only wins while the git value it was written against is unchanged.

### App scopes: per-app config in git

A descriptor's config can be customized **per app** straight from version control — no code declares scopes; you commit a JSONC file at an `@app/<id>` path and `./singularity build` does the rest. The app whose id is `<id>` then resolves the scoped values; every other app keeps the base value.

**To customize app `<id>` for the descriptor at `<plugin-tree>` (config name `<name>`, usually `config`):**

1. Create `config/<plugin-tree>/@app/<id>/<name>.jsonc`.
2. Put **only the fields that differ** for that app, e.g. `{ "captureUrlByDefault": false }` (a partial delta — schema default-backfill fills the rest).
3. Line 1: `// @hash <hash>` copied from the **base** origin `config/<plugin-tree>/<name>.origin.jsonc`. A scoped override anchors to the base origin — **no scoped origin is ever committed**.
4. `./singularity build`. Propagation resolves the scope as `baseEffective ⊕ scopedDelta` and writes it to `~/.singularity/state/config/<wt>/<plugin-tree>/@app/<id>/<name>.origin.jsonc`.
5. `./singularity check config-origins-in-sync` validates the `@hash` against the base origin and the document against the schema.

This is the base-override workflow (Layer 1) one path segment deeper. Any registered descriptor can be git-scoped — it does **not** need `scope: "app"` (that marker only governs the theme "Customize for app" fork-all-descriptors UX).

**Reading a scoped value (consumer):** thread the app scope yourself — `config_v2` is app-agnostic. `useConfig(cfg, { scopeId: appId ? \`app:${appId}\` : undefined })` with `appId = useCurrentAppId()`. Every scope with its own config is preloaded by the boot snapshot (with the scopes map that decides it), so the scoped value paints on the first frame (no flash). On the server, `getConfig(cfg, "app:<id>")`.

**Scoped read/write are symmetric.** Both ends key off the **same** server predicate, `scopeHasOwnConfig(descriptor, scopeId)` (the scope's origin OR override exists), so they can never disagree:

- **Read.** `useConfig` decides whether to read the scoped document purely from membership in the live `configScopes` map (`config-v2.scopes`, param-less: every server-registered storePath → its scope ids), recomputed from `scopeHasOwnConfig` on every scoped-file change — so a scope counts whether it became real via a committed git scope, a theme fork, **or a plain scoped `setConfig` write**. A non-member scope's read is skipped (`useLive(configValues, null)`) and the global document is used; a member's document not settled yet falls back to the global value, never `descriptor.defaults`. While the map itself is unknown a scoped read is `pending` (preloaded, so only after a failed boot). The same map lists every registered path, which is how `useConfigResult` throws on a web-only half-registration. `useScopeMembership` returns the membership as a `ResourceResult<boolean>` (the theme "Customize for app" toggle reads it) but does **not** gate `useConfig`.
- **Write (fork-on-write).** A scoped `useSetConfig`/`setConfig` to a scope with **no own config yet** auto-snapshots the current base into that scope's origin (the same redacted snapshot `forkScope` writes) and then writes the override — no explicit fork ceremony. A write when no **base** origin exists at all still throws "run ./singularity build".

**Semantics:** a committed scope is a frozen snapshot of `baseEffective ⊕ delta` recomputed each build, so its non-overridden fields track the git base as of the last build, not a runtime base edit. A runtime user fork layers on top; un-customizing drops the runtime override and falls back to the committed scope, not to global. The fork wins only while its hash matches: committing (or changing) the scope rewrites the scope's origin under a runtime fork, so the fork goes stale — the committed value takes effect and the user sees a conflict, exactly as for a base override.

**Per-app scopes in settings:** the config detail pane is scope-aware — a **Base** tab plus one tab per customized app (live from `configScopes`); selecting a tab re-keys every read and write to that `scopeId`. **`+` App** forks a new per-descriptor customization (`fork-descriptor-scope`); **Stop customizing** (`remove-descriptor-scope`) drops the descriptor's whole per-app customization — distinct from "Reset all", which only reverts edits to the scoped origin.

### Hash chain

Each layer's override records the hash of its *own* origin on line 1: a git override's `// @hash` tracks code changes; a user override's tracks git-config changes (code *and* agent overrides).

### Override semantics

Overwrites are **full copies**, not deltas: `setConfig` writes `{ ...currentValues, [key]: newValue }`, always a complete document. `parseDocument` fills missing keys from defaults, so a hand-written partial file still degrades gracefully.

### Conflict precedence: origin wins until reconciled

`effective(origin, overwrites)` normally returns the override when it exists. But when the override's `// @hash` is stale (a **conflict** — the origin moved underneath an override written against an older version), the **origin takes precedence** until the user reconciles: edit a field (rewrites the override against the current origin), "Keep my values" / acknowledge-conflict (bumps the hash so the override wins again), "Accept new defaults" / delete-override (drops the override), or **"Merge"** / merge-conflict (below).

### Three-way merge (ancestor snapshot)

"Keep my values" and "Accept new defaults" are all-or-nothing. The **Merge** resolver reconciles per field: only-user-changed keeps the user's value, only-upstream-changed takes the new default, and both-changed-differently is a true conflict left for manual resolution.

A three-way merge needs the **base** — the origin the override was written against — but only its hash lives in `// @hash`, and the user-layer origin is propagated by build, not versioned. So `propagate()` **snapshots the base at the conflict transition**: about to overwrite a user origin an *in-sync* override depends on (`oldOrigin.hash === override.hash && override.hash !== newHash`), it first writes the old origin to a sibling `<name>.ancestor.jsonc`. That predicate is idempotent — once the override is stale the hashes differ, so repeated builds never clobber the true base — and `propagateConfigToUser` deletes any orphaned ancestor on a no-conflict build.

`threeWayMerge(base, ours, theirs)` (pure, `tier-logic.ts`) returns the merged document plus the truly-conflicting keys. `computeAllConflicts` attaches `trueConflictKeys` to the `kind: "hash"` entry when an ancestor exists; its presence is what makes the UI offer **Merge** (legacy conflicts with no ancestor fall back to binary Keep/Accept). `mergeConflictByPath` bumps the hash and deletes the ancestor when nothing truly conflicts; otherwise it keeps the stale hash so the conflict stays surfaced, and re-running Merge finalizes it. Every terminal resolution (acknowledge-conflict, delete-override) also deletes the ancestor.

**Every config file on disk must carry a `// @hash` header** — the anchor conflict detection compares against; a hashless file is corrupt, not a benign "untracked" override. Enforced by throwing at both boundaries: `jsoncConfigProxy.read()` on a hashless file, and `setConfig` rather than fabricating a hashless override when no origin has been propagated. There is no "null hash wins" fallback.

Because the running app resolves to origin during a conflict, the settings editor binds to `conflictEntry.overrideValues` (the user's override document on disk), not to `useConfig` (the resolved value) — otherwise the user could neither see nor fix their pending override.

### Config migrations (saved values after a shape change)

When the shape a field STORES changes (a value re-spelled, a key renamed), the
user layer — not in git — must be rewritten once per namespace. Declare it on
the descriptor:

```ts
defineConfig({
  migrations: [defineConfigMigration({ id: "saved-icons-to-symbols", apply: (doc) => … })],
  fields: { … },
});
```

`./singularity build` (`propagateConfigToUser`, before it propagates) applies
every migration the namespace has not applied yet to that config's origin,
override and ancestor documents, base and `@app/<id>` scopes, and records it in
`.config-migrations-applied.json`; a namespace with no saved config records
them without running. Hash chains are kept (a rewritten origin gets its new
hash and its override is re-stamped), so overrides stay in force. `apply` must
be idempotent; never delete a migration that may not have run everywhere. The
committed `config/` files are rewritten by hand in the same diff. The ledger
engine (`runConfigLedger`, `rewriteConfigFiles`) is `config_v2/plugins/ledger`,
shared with plugin moves.

### Plugin moves and stranded overrides

A config's user-layer path is its plugin's id, so moving a plugin moves where its saved settings must live. `./singularity plugin move` records every move in a committed ledger, and each build replays it onto its own namespace's user dir before propagation — folder moved, saved reorder keys re-rooted, `// @hash` chain kept so overrides stay in force. See `plugins/plugin-meta/plugins/relocate/CLAUDE.md` ("Saved settings follow the move").

An override that still ends up where no live config reads it (plugin removed, or a move onto a destination that already had settings) is found by `auditUserConfigOrphans` — never deleted, since the user layer is not versioned. `debug/config-orphans` shows it: a notice pinned above Settings → Config, the Debug → Config Orphans panel, and one rolling `config-orphans-stranded` report filed at boot.

### Schema evolution

Adding a field to an existing config (including a `listField` item or `objectField` sub-field) must not break documents stored before the field existed. Two mechanisms guarantee this:

- **Default-backfill.** Every `FieldsRecord`→`z.object` composition (`fieldsToZodObject`, `listField`, `objectField`) wraps each field schema via `fieldSchemaWithDefault(field)` = `field.schema.default(field.defaultValue)`, and `defineConfig` builds its schema as `fieldsToZodObject(fields).passthrough()` (`fieldsToZodObject` is strict; config adds the unknown-key tolerance). A key missing from a stored document heals to that field's default instead of failing validation; the file self-heals on the next `setConfig`.
- **Invalid surfacing, not silent fallback.** When the effective document still fails the schema after backfill (a genuine break — a field's type changed under stored data, a bad hand edit), `readTypedConfig` resolves to defaults *and logs a warning*, while `computeAllConflicts` emits a `kind: "invalid"` entry carrying structured `issues` (`{ path, message }`, see `configV2ValidationIssueSchema`) that the settings detail renders as a destructive banner pinpointing each bad field — so disappearing data is never silent. Hash conflicts (`kind: "hash"`) take precedence when both apply. A missing document is the legitimate defaults case, not an "invalid" one.

### Checks

`config-origins-in-sync` (single check, double duty):
1. Every `.origin.jsonc` in `config/` matches current `defineConfig` defaults
2. Every `.jsonc` override has a `// @hash` matching its current origin

`config:overrides-authored` (`check/overrides-authored.ts`) — see
[mandatory overrides](#mandatory-overrides-requiresauthoredoverride) below: a filesystem
scan of `config/**/*.jsonc` (excluding the generated `.origin`/`.ancestor` siblings)
failing on any file still carrying the seeded `// @review` marker. `alwaysRun` (fails
`--skip-checks` builds too) and never cached — the marker is minted by the build itself,
after that run's tree hash was taken.

`config-v2:registrations-paired` (`check/registrations-paired.ts`) — every server
`ConfigV2.Register` has a matching web `ConfigV2.WebRegister` at the same storePath, and
vice versa.

### Mandatory overrides (`requiresAuthoredOverride`)

A descriptor whose committed override must be **deliberate, not defaulted** declares
it:

```ts
defineConfig({
  name: slotId,
  requiresAuthoredOverride: {
    guidance: ["Arrange \"items\" for how this slot renders", "(sidebar = vertical list, toolbar = horizontal bar)"],
    // Optional. "Is there anything here to author?" — omit to always seed.
    seedWhen: (defaults) => Array.isArray(defaults.items) && defaults.items.length > 0,
  },
  …
})
```

`./singularity build` then does the mechanical half: it **seeds** a missing
`config/<tree>/<name>.jsonc` from its origin — same `// @hash`, same body, same legend
comments — with a one-line `// @review` marker plus the descriptor's `guidance` lines
after the hash header; and it **re-marks + re-stamps** an existing override whose origin
hash moved underneath it. The human half is: arrange the values, delete the marker line.

`seedWhen(defaults)` gates **creating** a file, and only that. Some defaults are vacuous —
a render slot with no contributions has no arrangement to make, so `{"items": []}` would
be a review a human can only rubber-stamp, burying the files where a decision is pending.
`defaults` is the ORIGIN's effective document (post `OriginDefaultsProvider`), not
`descriptor.defaults` — reorder's catalog is materialized at build time, so its field
default is always `[]`. The descriptor stays REGISTERED regardless: never express this by
withholding the descriptor, or `pruneOrphanedConfigFiles` deletes an authored override the
moment its slot empties. An existing file is never seeded, deleted or skipped — and still
re-marks when it goes stale, since "your slot lost every contribution" is worth saying.

`guidance` is **descriptor-supplied prose**, so neither the engine nor the check ever
names a config family — the check just echoes each offending file's own marker block back,
and a new family that opts in needs zero edits to either. Today's consumers: reorder's
`reorderDirectiveDescriptor` (per reorderable slot) and data-view's `viewsDescriptor`
(per DataView surface).

Why *review* rather than *presence*: seeding makes absence self-healing (delete a
required override and the next build re-seeds it, marked, which fails), and a stale hash
stops being discharged by retyping it — retyping was acknowledgement, not review.

Seeding is **build-only** (never in the shared `regenerateManifestCodegen` pipeline)
because `regen-generated` runs inside push's merge-driver path followed by an amend
commit, so a marker minted there would land unreviewed; it asserts marker-free instead.
Design:
[`research/2026-07-23-global-authored-override-seeding.md`](../../research/2026-07-23-global-authored-override-seeding.md).

### Override legend (`overrideLegend`)

`defineConfig({ overrideLegend: [...] })` declares how to hand-write the descriptor's
values. The build keeps those lines as a `// @legend` block right under `// @hash` in
**every** existing committed override (base and `@app/<id>/` forks) — `withOverrideLegend`
(core) is the one writer, called by the `overrideLegends` step of the shared codegen
pipeline and by the seeder. Re-stamped every build because nothing else keeps it: the
runtime writer re-serializes without comments, and authors delete what they don't need
today. The block is build-owned (hand edits inside it are lost); it never creates a file
or touches the body. Consumer: reorder's `reorderDirectiveDescriptor`
(`REORDER_NODE_LEGEND`), so every slot's layout file says a spacer exists.

### Internal architecture

- **`mapConfigLists` (`core/internal/collections.ts`) — THE walk over every `listField` instance in a document**, at any depth (through `itemFields` and `subFields`). A config document is recursive; every consumer that walked it one level deep drifted. Used by `normalizeCollectionItems` (id seeding), the `config-stable-list-ids` check, and `diffNormalForm` (the layer-comparison normal form behind the tiers/modified attribution). It visits a list **before** recursing into its rows, because a row's `auto-` id hashes that row's content — seeding nested ids first would re-mint every enclosing id.
- **`jsoncConfigProxy`** — synchronous read/write with `// @hash` header tracking. Used for propagation, `setConfig`, and `reloadValues`.
- **`ConfigWatcher`** (`config-watcher.ts`) — `@parcel/watcher` file-change detection on `~/.singularity/state/config/`. Debounce (100ms) + ceiling (1s); the blanket 30s reconcile is deliberately **disabled** (`reconcileMs: null`) — it re-fired every watched path (2 per descriptor) into a full conflicts recompute, an O(N²) idle re-read storm with nothing changed. Callbacks are `() => void`; the registry re-reads via `jsoncConfigProxy` on notification.

  These events are a **push-latency** mechanism, not a correctness one — an event can be missed (an out-of-band writer parcel doesn't observe, a dropped fsevent, a path no `CacheEntry` registered). **Never treat "no event" as "no change"**: derived state must be founded on the disk, per the fingerprint memo below.

- **`refreshEntry` (`registry.ts`) — the single "this entry's files changed" path** (re-read from disk → replace `CacheEntry.values` → notify subscribers + `notifyDocument`). Called from **both** the watcher (out-of-band writes) **and every in-process writer right after its own write** (`setConfig`, `acknowledgeConflictByPath`, `mergeConflictByPath`, `deleteOverrideByPath`). The second is NOT redundant: on a missed watcher event a writer that waited for its own event would leave `entry.values` stale indefinitely, so `getConfig` — and with it the `config-v2.values` push and the boot snapshot's preload of it — would keep serving the pre-write document while the correct value sits on disk. Any new file-mutating path must call it (scoped fork/unfork instead rebuilds via `ensureScopeEntry`/`disposeScopeEntry`). It carries provider-backed (secret) field values forward — they live outside the JSONC document.

### Agent-write ledger (config an automated session overwrote)

Every config write takes a **required** `writer: WriteOrigin` (`ConfigWriteOpts`,
`registry.ts`) — `originOf(req)` at an HTTP boundary, `systemOrigin("…")` for a
job or boot. It replaced the trailing optional `scopeId`, so omitting it is a
`tsc` error rather than a silent downgrade. Named `writer`, not `origin`, for the
same reason descriptors carry `source`: `origin` already means `.origin.jsonc`.

When the writer is `agent`, the document's **whole trio** (origin / override /
ancestor) is snapshotted before the write, in config's ledger (`id: "config"`,
label "Config documents") of the shared
[`agent-write-ledger`](../infra/plugins/request-origin/plugins/agent-write-ledger/CLAUDE.md)
primitive — which owns capture, persistence, the divergence check and the
`/api/agent-writes` routes the e2e harness calls. The trio, not just the
override, because `forkDescriptorScope` writes the scoped origin too and the
conflict resolvers touch the ancestor.

config_v2 keeps two things. **The handle**, `configWriteLedger` in
`registry.ts`, which every write path (and `scope-fork.ts`) records through. Its
key is `<storePath>` or `<storePath> @<scopeId>` (`config-ledger-key.ts`), read
back out by the restore. **The restore**, `applyRestore`, beside the private
cache helpers it needs: it puts the bytes back and then re-syncs through
`refreshEntry` / `ensureScopeEntry`. That re-sync is why the revert goes through
the server rather than the harness rewriting files: a filesystem restore would
depend on the `CONFIG_DIR` watcher, which is push-latency, not correctness (see
above).

**Not covered:** provider-backed (secret) fields, which return before touching
the JSONC layer at all — an agent write there is not revertible by a bytes
ledger.
[`research/2026-08-30-global-agent-config-write-revert-ledger.md`](../../research/2026-08-30-global-agent-config-write-revert-ledger.md)

### Derived aggregates (conflict-locations / scopes / modified-counts)

Three aggregate live resources summarize all ~180 descriptors at once. They are cheap because none of them re-reads every config file per load — but they arrive at that in two *different* ways, and the difference is load-bearing.

All of config's live resources are live values (`network/live`), declared with `liveValue` in `core/internal/resource.ts` and served with `serveValue(…, { source: "external" })` in `server/internal/resource.ts` — external because their truth is the files on disk, which no change feed sees:

- `configValues` (`config-v2.values`, `{ path, scopeId? }` — `"scopeId?"` is an optional param; absent or `""` names the base document) and `configScopes` (`config-v2.scopes`, param-less) are `preload: "boot-and-keep"`. `configValuesServed`'s `preloadParams` names every registered `{ path }` plus every `{ path, scopeId }` in the SAME `scopeMembers` map `configScopes` is read from, so the scoped documents hydrated and the membership that selects them cannot disagree. This replaced config's own `Core.Boot` task, its `GET /api/config-v2/snapshot` endpoint and the `resident` flag (Resources page item 9).
- `configConflict` (`config-v2.conflicts`) and `configTiers` (`config-v2.tiers`), `{ path, scopeId? }`, move in lock-step with the document. Every writer calls ONE fan-out, `notifyDocument(storePath, scopeId)` (`registry.ts`): it derives the tuples a change moved once (a scoped change its own tuple; a base change the base tuple plus every known scope with no config of its own) and notifies all three per-document values for each, then refreshes modified-counts and conflict-locations.
- `configConflictLocations` and `configModifiedCounts` (param-less) push through `configConflictLocationsServed.notify()` / `configModifiedCountsServed.notify()`. Neither is preloaded. While one is pending the attention dots render nothing, and the config nav renders its loading state until both have landed — its Modified / Conflict fields decide which rows a filtered view (the authored "Conflicts" view) keeps, so rows shown before then would claim "no conflicts".

**`config-v2.conflict-locations` — derived from disk, memoized on a file fingerprint.** Its loader is the authority: it re-derives, for every descriptor, WHICH scopes conflict (base and/or each on-disk app scope) through the *same* `derivedDescriptorConflict` memo the per-descriptor `config-v2.conflicts` resource uses, so the nav ⚠ badge, its tooltip, the scope-tab dots and the detail banner can't disagree. It reports scope ids rather than a boolean on purpose: a badge that only knows "somewhere" sends the user to a detail pane that opens on a clean Base and shows nothing. The memo keys `(storePath, scopeId)` on `(inode, mtime-ns, size)` of the file trio (origin / override / ancestor), so an unchanged descriptor costs 3 `statSync`s, not 3 read+parse+hash. `inode` is what makes it airtight — `jsoncConfigProxy.write` renames a temp file into place, so even a byte-length-identical hash restamp changes it.

The memo key comes from **the filesystem, not an event** — deliberately. `refreshConflictLocations` still runs from the watcher path, but only as a *push-latency* optimization (it diffs a "last published" snapshot and notifies on a flip); it is never the value the loader reads, so a missed watcher event can delay a push but can't produce a wrong answer.

**`config-v2.modified-counts` — derived from disk, through the same memo.** Its loader sweeps every registered descriptor and counts the BASE fields whose tier is `"user"` (below), so the nav badge and the detail pane can never disagree about what "modified" means. `refreshModifiedCount` survives only as the push path — it diffs a "last published" count and notifies on a flip — and is never the value the loader reads.

**`config-v2.scopes` (storePath→scopeIds) — still an event-fed in-memory map** in `resource.ts`, recomputed per changed descriptor by `refreshScopeMembers` (boot warm-up + `registry.ts`'s notify path). It reads nothing from disk per load — and so **does** go stale on a missed watcher event. Applying the fingerprint-memo treatment above is the intended fix; conflict-locations and modified-counts have had it, this one hasn't.

`config-v2.conflicts` is keyed per-descriptor (`{ path, scopeId? }`) so opening one config page recomputes one descriptor, not the whole ~180-descriptor map. `config-v2.tiers` is keyed the same way and rides the same memo record — as a **lazily computed slot**, because the conflict-locations sweep reads every descriptor's conflict entry and must not start paying to normalize and diff two documents it never looks at.

### What "modified" means

**A field is modified when the USER layer supplied its value — not when it differs from `descriptor.defaults`.** The git layer (the generated origin ⊕ any committed authored override, propagated down by build) is what the repo commits, and a value the repo commits is not something the user changed. The old basis marked all ~157 descriptors with a committed override as permanently modified, and every reorder slot always — a build-materialized descriptor's declared default is `[]` while its origin is the live contribution catalog.

`config-v2.tiers` is the single answer, per field, and everything reads it: the `git`/`user` badge, the accent stripe, the per-field Reset, the nav count badge, the "Modified only" filter, and the "Reset all" gate.

- **Which layer won is decided once**, by `readTypedConfigWithLayer` (`tier-logic.ts`) — the cascade `readTypedConfig` is now a wrapper over. Only a WINNING override can have modified anything: a stale, foreign or schema-invalid override is one the runtime resolves past, and it differs from the origin in every key. So **while a config is in conflict no field reads modified** — no stripes, no per-field Reset, no "Reset all"; the banner's Keep / Accept / Merge own that state, and "Reset all" was only "Accept new defaults" under another name.
- **`computeFieldTiers` (`server/internal/field-tiers.ts`) refines that to a per-key answer**, because `setConfig` writes FULL documents — a winning override "contains" the git layer's value for every field the user never touched. A key the override document omits is not an edit; it falls through to the git-vs-default comparison.
- **Both sides go through one normal form** (`diffNormalForm`, same file): drop `id` from rows of non-`stableIdentity` lists, at any depth, via `mapConfigLists`. `normalizeCollectionItems` seeds an `auto-<hash>` id on every id-less row on read and on write, so a user override carries them — while the BASE user origin is propagated byte-wise from a git origin codegen never normalizes and carries none. Without this, toggling one boolean marks every list field of that config modified forever. A `stableIdentity` list is left alone: its ids are durable external keys, so a differing id there is a real difference.
- **Per-field Reset restores the git-layer value**, not the code default (`resetConfigByPath`) — and when the reset leaves the user document saying nothing the origin doesn't already say, it DELETES the override instead of writing a copy of the origin into it, so a phantom override can't become a stale-hash conflict banner on the next build. Never while a conflict is open: deleting the override there is a terminal resolution that takes the ancestor (the merge base) with it.
- **`ConfigRegistration.descriptor` is typed `Omit<ConfigDescriptor, "defaults">`** so the settings pane cannot reach the code default at all. `defaults` stays on the descriptor itself (`useConfig` needs it for the pre-hydration window); withholding it from the registration is what stops a fourth surface from re-deriving "modified" the wrong way.

## Config in a demo scope (the browser server)

Inside a `<DemoScope>` config is served by the page, never the host
(`web/internal/demo-resource.ts`, contributed as `Demo.Resource` "config-v2").
It runs the server's tier cascade (`readTypedConfig`) over two browser layers
built on the `ConfigProxy` seam:

- **Git layer** — the committed `config/` resolved by `resolveGitLayer` (core;
  the same rule `propagateConfigToUser` propagates with: `override ⊕ origin`, a
  stale override losing; each `@app/<id>` delta over that base). `./singularity
  build` bundles it PER COMPOSITION (codegen's `config-git-layer-gen.ts`, stage
  2 after the seeder) as the GITIGNORED `.generated/composition-modules/config-layer.<name>.ts`,
  keeping only the composition's own plugins (its web registry) and its own
  apps' `@app` scopes, and of those only documents the committed layer arranges
  — a path with only its generated origin reads its code `defaults`, which it
  equals. It is NOT in this plugin's artifact (which every composition shares):
  it is a composition module, served from the deployed composition's registry
  artifact behind `@composition-config-layer` (typed by
  `web/internal/composition-config-layer.d.ts`; `web-artifacts`'
  `composition-modules.ts`). Loaded by a dynamic import, so only a demo fetches
  it. Committed files hold no secrets (provider fields keep their default
  there), so nothing is redacted.
- **User layer** — `createMemoryConfigStore()` (core), one per scope mount.
  The scope's own `POST /api/config-v2/set-field` writes a full document
  `{ ...current, [key]: value }` (schema-checked, 400 otherwise) under the hash
  of the origin it resolved against, and notifies its tuple; a scoped write to a
  scope with no document forks it (the base as it resolves becomes the scope's
  origin) and notifies `config-v2.scopes`. A remount or reload is the committed
  state again. A persistent store (IndexedDB / OPFS) is the same interface.

The settings app's keys (`conflicts`, `tiers`, `raw-file`, …) and its other
write endpoints stay unserved in a demo and fail loudly. Design:
[`research/2026-10-16-global-config-git-layer-in-browser-server.md`](../../research/2026-10-16-global-config-git-layer-in-browser-server.md),
per-composition scoping:
[`research/2026-10-16-global-config-git-layer-per-composition.md`](../../research/2026-10-16-global-config-git-layer-per-composition.md).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Reactive useConfig hook for reading typed JSONC config in the browser. Typed JSONC config handles for server plugins.
- Web:
  - Slots: `ConfigV2.WebRegister`
  - Slot contributors: 88 contributors — full list in [REFERENCE.md](./REFERENCE.md)
    - `ConfigV2.WebRegister` ×88
  - Contributes: `Demo.Resource` "config-v2"
  - Uses:
    - `framework/browser-server/demo.Demo`
    - `infra/endpoints.useEndpointMutation`
    - `network/live.useLive`
    - `primitives/live-state.combineResources`
    - `primitives/live-state.foldResource`
    - `primitives/live-state.mapResource`
  - Exports (types): `ConfigRegistration`
  - Exports (values):
    - `ConfigV2`
    - `useConfig`
    - `useConfigRegistrations`
    - `useConfigResult`
    - `useScopeMembership`
    - `useSetConfig`
- Server:
  - Contributes:
    - `resource.declare` "config-v2.conflict-locations"
    - `resource.declare` "config-v2.conflicts"
    - `resource.declare` "config-v2.modified-counts"
    - `resource.declare` "config-v2.raw-file"
    - `resource.declare` "config-v2.scopes"
    - `resource.declare` "config-v2.tiers"
    - `resource.declare` "config-v2.values"
  - Uses:
    - `infra/file-watcher.acquireDirWatch`
    - `infra/file-watcher.defineFileWatcher`
    - `infra/file-watcher.FileWatcher`
    - `infra/paths.REPO_ROOT`
    - `infra/paths.repoConfigDir`
    - `infra/request-origin/agent-write-ledger.AgentWriteLedgerEntry`
    - `infra/request-origin/agent-write-ledger.defineAgentWriteLedger`
    - `infra/request-origin/agent-write-ledger.FileSnapshot`
    - `network/live.serveValue`
  - Exports (types):
    - `ConfigWriteOpts`
    - `FieldStorageProvider`
  - Exports (values):
    - `acknowledgeConflictByPath`
    - `auditUserConfigOrphans`
    - `configRegistryReady`
    - `ConfigV2`
    - `configValuesServed`
    - `configWatcherArmed`
    - `deleteOverrideByPath`
    - `deleteScope`
    - `forkConfig`
    - `forkDescriptorScope`
    - `forkScope`
    - `getAllDescriptors`
    - `getConfig`
    - `getConfigScopeIds`
    - `getFieldStorageProvider`
    - `getScopedDescriptors`
    - `hasFieldStorageProvider`
    - `mergeConflictByPath`
    - `onConfigDirChange`
    - `registerFieldStorageProvider`
    - `removeDescriptorScope`
    - `resetConfigByPath`
    - `setConfig`
    - `setConfigByPath`
    - `watchConfig`
  - Register: `defineFileWatcher('config_v2.config-files')`
  - Resources:
    - `config-v2.conflict-locations` (push, notified)
    - `config-v2.conflicts` (push, notified)
    - `config-v2.modified-counts` (push, notified)
    - `config-v2.raw-file` (push, notified)
    - `config-v2.scopes` (push, notified)
    - `config-v2.tiers` (push, notified)
    - `config-v2.values` (push, notified)
- Core:
  - Uses:
    - `fields.fieldsToZodObject`
    - `fields/list/config.isListFieldDef`
    - `fields/list/config.ListFieldDef`
    - `fields/object/config.isObjectFieldDef`
    - `infra/endpoints.defineEndpoint`
    - `network/live.liveValue`
    - `primitives/rank.Rank`
  - Exports (types):
    - `ConfigDescriptor`
    - `ConfigListVisitor`
    - `ConfigMigration`
    - `ConfigProxy`
    - `ConfigSource`
    - `ConfigStore`
    - `ConfigV2ConflictEntry`
    - `ConfigV2ConflictLocations`
    - `ConfigV2ConflictMap`
    - `ConfigV2Conflicts`
    - `ConfigV2ModifiedCounts`
    - `ConfigV2Scopes`
    - `ConfigV2ScopesMap`
    - `ConfigV2Tiers`
    - `ConfigV2ValidationIssue`
    - `ConfigV2Values`
    - `ConfigValues`
    - `Disposable`
    - `GitLayerDocument`
    - `JsonValue`
    - `OriginDefaultsFrom`
    - `OrphanEntry`
    - `OrphanFile`
    - `OrphanFileRole`
    - `OrphanReason`
    - `OrphanReport`
    - `OrphanRiskClass`
    - `ResolvedConfig`
    - `ResolvedLayer`
  - Exports (values):
    - `APP_SCOPE_DIR`
    - `appScopeId`
    - `codeConfigProxy`
    - `computeHash`
    - `configConflict`
    - `configConflictLocations`
    - `configFileOwner`
    - `configModifiedCounts`
    - `configRawFile`
    - `configScopes`
    - `configTiers`
    - `configV2ConflictEntrySchema`
    - `configV2ConflictLocationsSchema`
    - `configV2ConflictMapSchema`
    - `configV2ConflictsSchema`
    - `configV2ModifiedCountsSchema`
    - `configV2ScopesMapSchema`
    - `configV2ScopesSchema`
    - `configV2TiersSchema`
    - `configV2ValidationIssueSchema`
    - `configV2ValuesSchema`
    - `configValues`
    - `createMemoryConfigStore`
    - `defineConfig`
    - `defineConfigMigration`
    - `deleteScope`
    - `effective`
    - `forkDescriptorScope`
    - `forkScope`
    - `hasConflict`
    - `hasReviewMarker`
    - `mapConfigLists`
    - `normalizeCollectionItems`
    - `orphanEntrySchema`
    - `orphanFileRoleSchema`
    - `orphanFileSchema`
    - `orphanReasonSchema`
    - `orphanReportSchema`
    - `orphanRiskClassSchema`
    - `propagate`
    - `readonlyProxy`
    - `readTypedConfig`
    - `readTypedConfigWithLayer`
    - `removeDescriptorScope`
    - `resolveGitLayer`
    - `REVIEW_MARKER`
    - `scopeAppId`
    - `setConfigField`
    - `stringifyConfigValue`
    - `threeWayMerge`
    - `validationIssues`
    - `withOverrideLegend`
- Cross-plugin:
  - Uses tokens: `ui/tokens/shape --spacing`
  - Imported by: 111 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `apps` ×31
    - `backup` ×13
    - `conversations` ×13
    - `debug` ×13
    - `ui` ×11
    - `auth` ×6
    - `tasks` ×4
    - `config_v2` ×3
    - `primitives` ×3
    - `infra` ×2
    - `stats` ×2
    - `build`
    - `fields/secret/config`
    - `framework/tooling/codegen`
    - `integrations/gmail`
    - `map/google`
    - `plugin-meta/composition`
    - `reorder`
    - `reports`
    - `review/code-review`
    - `shell/global-action-bar`
- Exemptions:
  - Exempts itself from: `boundaries/no-platform-api` — `server/internal/config-watcher.ts`, `server/internal/fork.ts`, `server/internal/jsonc-proxy.ts`, `server/internal/orphan-audit.ts`, `server/internal/registry.ts`, `server/internal/resource.ts`, `server/internal/scope-fork.ts`, `server/internal/scope-paths.ts`, `server/internal/scope-snapshot.ts` (debt)
- Test helpers:
  - Web: `@plugins/config_v2/web/testing`
    - `useConfigDemoBackend` — Config inside a demo scope (`Demo.Resource`): the server's tier cascade over two browser layers, so a demo surface reads exactly what a fresh user of the committed repo would — and can change it.
    - Types: `GitLayer`, `LoadGitLayer`
  - Core: `@plugins/config_v2/core/testing`
    - `LEGEND_MARKER` — The build-owned `// @legend` block of a committed config override: a descriptor's `overrideLegend` lines, stamped directly under the `// @hash` header so whoever opens the file to hand-edit it sees how to write its values — for a reorder slot, that a spacer node exists and what it does.
- Sub-plugins:
  - **`config-link`** — Deep-link affordances from any config-backed surface to its settings section. useConfigLink() links a descriptor to its config pane; ConfigGearButton and ConfigPopoverHeader surface it as a gear…
  - **`fields`** — Field type registry. Sub-plugins contribute field types with core factories and web renderers.
  - **`ledger`** [exempt] — The rewrite-saved-config-once ledger: replays keyed entries (plugin moves, config migrations) onto a namespace's user-layer config before propagation, recording each per namespace and keeping the…
  - **`settings`** — Settings UI for config_v2: two-pane nav + detail surface for viewing and editing typed config fields. Surfaced inside the Settings app. HTTP endpoints for setting and resetting config_v2 field…
    - Plugins:
      - **`conflict-agent`** — Ask-an-agent button inside the config detail's conflict banners: opens the standard task-draft popover pre-filled with a factual description of the conflict (which fields disagree, and how).

<!-- AUTOGENERATED:END -->
