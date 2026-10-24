# "Modified" means differs from the git layer, not from the code default

## Context

In Settings, four things claim to know whether a config field has been changed:

- the per-field accent stripe (`isFieldModified`,
  [`config-field.tsx:37`](../plugins/config_v2/plugins/settings/web/components/config-field.tsx))
- the per-field **Reset** button, offered on exactly the fields that stripe marks
- the per-config count badge and the "Modified only" filter in the config nav
  (`computeModifiedCount`,
  [`resource.ts:382`](../plugins/config_v2/server/internal/resource.ts))
- the **Reset all** toolbar button (`hasAnyModified`,
  [`config-detail.tsx:219`](../plugins/config_v2/plugins/settings/web/components/config-detail.tsx))

All four answer by diffing the live value against `descriptor.defaults` — the raw
value `defineConfig` declared in code. That is the wrong basis. The repo commits a
git layer: a generated `config/<hier>/<name>.origin.jsonc` plus, for 157 of the
~180 descriptors, a hand-authored `config/<hier>/<name>.jsonc` on top. `./equin build`
resolves those two and propagates the result down to
`~/.singularity/state/config/<wt>/<hier>/<name>.origin.jsonc`. Only the file
beside it — `<name>.jsonc`, written by `setConfig` — is the user's own layer.
"Modified" should mean "the user layer supplied this value".

Two consequences today:

1. Every config with a committed authored override permanently reads as modified,
   and offers Reset on a field that is already exactly what the repo says.
2. Worse for reorder-directive descriptors (`originDefaultsFrom: "build"`), whose
   committed origin is the live contribution catalog while `descriptor.defaults.items`
   is `[]`. Every reorder config reads as modified, always, and its count is wrong
   by construction. Live example in this worktree:
   `config_v2/settings/config-v2-nav.actions.origin.jsonc` is
   `{"items": ["primitives.pane:title"]}` against a `[]` default.

Same root cause as the just-landed `readGitLayerConfig` fix — treating
`descriptor.defaults` as if it were the origin document. See
[`2026-08-26-global-origin-defaults-source-declared-on-descriptor.md`](./2026-08-26-global-origin-defaults-source-declared-on-descriptor.md),
whose "Adjacent findings" section lists this and the reset bug fixed here.

**Outcome.** One server-side function answers "which layer supplied this field's
value", every surface reads it, and the code default stops being reachable from
the settings pane at all.

---

## The definition

`computeTiers` ([`resource.ts:470`](../plugins/config_v2/server/internal/resource.ts))
already computes a per-field `"default" | "git" | "user"` attribution from the two
documents on disk, already pushes it per `(path, scopeId)` as `config-v2.tiers`,
and `ConfigField` already receives it as a `tier` prop to draw a badge with. The
whole change is:

> **modified ⟺ `tier === "user"`**

and then making `computeTiers` the only place that decides.

But `computeTiers` as written has two bugs that only tint a badge today and would
drive the stripe, the Reset button and the nav count tomorrow. Both must be fixed
as part of this, not after it.

### Bug A — a key absent from the override reads "user"

`fieldValueJson` ([`resource.ts:463`](../plugins/config_v2/server/internal/resource.ts))
returns the string `"undefined"` for a missing key, and any non-equal value marks
the field `"user"`. So a **foreign** override — the dead pre-`items` reorder
`{order, hidden}` shape, which shares no key with the field set and which
`readTypedConfig` deliberately degrades to the origin — marks *every* field of that
config as user-modified, on a config the runtime is not honouring at all. Same for
any hand-written partial override, which `CLAUDE.md` explicitly blesses.

The fix is to stop deciding layer-by-value and start deciding **layer-by-what-won**.
`readTypedConfig` ([`tier-logic.ts:155`](../plugins/config_v2/core/internal/tier-logic.ts))
already runs the cascade — non-stale, non-foreign, schema-valid override wins;
else origin; else code defaults — and `validationIssues` right below it already
re-implements the same cascade a second time. Extract the decision once:

```ts
// core/internal/tier-logic.ts
export type ResolvedLayer = "user" | "git" | "default";

export function readTypedConfigWithLayer<F extends FieldsRecord>(
  descriptor: ConfigDescriptor<F>,
  origin: ConfigProxy,
  overwrites: ConfigProxy,
): { layer: ResolvedLayer; values: ConfigValues<F>; overrideContent: JsonValue | null };
```

`readTypedConfig` becomes a one-line wrapper returning `.values`, so the hot read
path parses exactly once and there is one cascade, not two-and-a-half.

A field's tier then follows from the winning layer:

- `layer === "default"` → every field `"default"`
- `layer === "git"` → per key, origin vs `descriptor.defaults` → `"git"` or `"default"`
- `layer === "user"` → per key, if the override document **contains** the key and
  its value differs from the origin's → `"user"`; otherwise fall through to the
  git-vs-default comparison above

A consequence worth stating plainly: **while a config is in conflict (stale hash,
foreign, or invalid) the override is not the winning layer, so no field reads
modified.** No stripes, no per-field Reset, no "Reset all" — the conflict banner's
Keep / Accept / Merge own that state, and "Reset all" was already just the banner's
"Accept new defaults" under another name. This also removes, for free, the case
where a field only *upstream* changed would otherwise be marked as the user's edit.

### Bug B — list rows compare unequal because only one side has ids

`normalizeCollectionItems` ([`registry.ts:142`](../plugins/config_v2/server/internal/registry.ts))
synthesizes an `auto-<hash>` id on every id-less row of a non-`stableIdentity`
list. It runs on read and on write, so a user override on disk carries those ids —
but the **base** user-layer origin is propagated byte-wise from a git origin that
codegen never normalized, so it carries none. (Scoped origins are snapshots of
resolved values and *are* normalized; only the base origin is bare.)

So a user who toggles one boolean gets a full-document write that seeds ids into
an untouched list field, and that field then compares unequal to the origin
forever. `stripListIds` ([`config-field.tsx:27`](../plugins/config_v2/plugins/settings/web/components/config-field.tsx))
exists client-side for exactly this reason. Its idea is right and its placement is
wrong: it belongs on the comparison, server-side, and it must skip
`stableIdentity` lists, whose ids are durable external keys the consumer owns and
a genuine difference.

---

## Changes

Ordered. Nothing here moves `normalizeCollectionItems` — the comparison strips
ids, it does not mint them, so no import cycle appears and `registry.ts` keeps it.

### 1. `core/internal/tier-logic.ts` — one cascade

Add `ResolvedLayer` and `readTypedConfigWithLayer` as above; reduce
`readTypedConfig` to a wrapper. Export the type and the function from
[`core/index.ts`](../plugins/config_v2/core/index.ts). Leave `validationIssues`
alone for now (it needs the *reasons*, not just the winner) but note in its comment
that it mirrors the extracted cascade.

`tier-resolve.test.ts` already covers all four arms of the cascade and must keep
passing unchanged — it is the regression net for this extraction.

### 2. New `server/internal/field-tiers.ts` — the pure rule

```ts
export function computeFieldTiers(args: {
  fields: FieldsRecord;
  defaults: Record<string, unknown>;
  layer: ResolvedLayer;
  originContent: JsonValue | null;
  overrideContent: JsonValue | null;
}): ConfigV2Tiers;
```

Pure, no filesystem, no registry — so it gets a `field-tiers.test.ts` beside it
covering: committed-override-only reads `"git"` (the headline bug), a reorder
descriptor with `defaults.items === []` reads `"git"` not `"user"`, a foreign
override reads no `"user"` at all, a key absent from the override falls through,
an untouched list field beside a touched scalar reads `"git"`, and a
`stableIdentity` list with differing ids reads `"user"`.

Comparison runs both sides through a local `diffNormalForm(doc, fields)` built on
`mapConfigLists` (already exported from `@plugins/config_v2/core`): drop `id` from
rows of every non-`stableIdentity` list, at any depth. Comparison-only — it never
touches what is written.

Provider-backed (secret) fields are **not** decided here. They are forced to
`"default"` by the caller, after the memo (below), because
`registerFieldStorageProvider` is a module side effect and a memoized answer taken
before it registered would stick.

### 3. `server/internal/resource.ts` — one derivation, one count

- `computeTiers` becomes: resolve the file trio via the existing `conflictFilePaths`
  (drop its own inline path-splitting), call `readTypedConfigWithLayer`, call
  `computeFieldTiers`, then force provider-backed fields to `"default"`.
- Fold the tier map into the existing fingerprint memo, `derivedDescriptorConflict`
  ([`resource.ts:265`](../plugins/config_v2/server/internal/resource.ts)) — it is
  keyed on `fileStamp` of the same trio, so the documents get read once instead of
  twice, and tiers gain a memo they never had. Store tiers as a **lazily computed
  slot** on the memo record, not a field computed eagerly: `descriptorHasAnyConflict`
  sweeps every descriptor × scope on every `conflict-paths` load, and must not start
  paying for tiers it does not read.
- `computeModifiedCount(storePath)` = the number of base-scope tiers equal to
  `"user"`. Keep its existing `return 0` guard for an unregistered path — do not
  inherit `computeTiers`'s throw, since `refreshModifiedCount` runs inside
  `notifyValues` on every write and must not be able to take down a `setConfig`.
- **Make the loader the authority** (the second thing you asked for): sweep
  `[...descriptorByPath.keys()]` through the memo inside
  `configV2ModifiedCountsServerResource`'s loader, exactly as
  `configV2ConflictPathsServerResource` already does, and **delete the
  `modifiedCounts` map and `refreshModifiedCount` outright** — along with their two
  call sites in `registry.ts` (`notifyValues`, and the boot warm-up loop). That
  removes the count's second, event-fed basis rather than correcting it, and closes
  the staleness the plugin's own `CLAUDE.md` flags. Cost is the same stat-only sweep
  conflict-paths already pays on that surface.

Scope asymmetry, unchanged but now more visible, and worth a comment: conflict-paths
is a base ∪ all-scopes union while the count stays base-only, so a descriptor whose
only user override is scoped shows a ⚠ and no count.

### 4. `server/internal/registry.ts` — Reset restores the git value

`resetConfigByPath` ([`registry.ts:677`](../plugins/config_v2/server/internal/registry.ts))
stops writing `descriptor.defaults[key]`. New body for the non-provider path:

1. Read the user-layer origin document (`entry.userOriginPath`). No origin at all →
   throw, with the same "run `./equin build`" message `setConfig` uses; there
   is no state in which an override exists without one.
2. The reset value is `origin[key]`, falling back to `descriptor.defaults[key]`
   **deliberately and with a comment** when the origin predates the field — otherwise
   `setConfig`'s schema parse throws on `undefined` and Reset is a dead button on a
   config that just gained a field.
3. Compute the resulting document. If it equals the origin document under the same
   `diffNormalForm` from step 2 — raw equality would never fire for a list-bearing
   config — **and there is no conflict entry for this descriptor**, delete the
   override file instead of writing it, so a reset genuinely removes the user layer
   rather than leaving a phantom override that becomes a conflict banner on the next
   build. The conflict guard matters: without it, resetting the last differing field
   during a conflict would silently perform "Accept all new defaults" *and* delete
   the ancestor, taking the three-way merge with it.
4. Ledger: `recordWrite` before the unlink, `noteWrite` after `refreshEntry`, keeping
   the `reset-field:<key>` operation string. `deleteOverrideByPath` (`registry.ts:901`)
   is the shape to copy — an override deletion is already a representable, revertible
   ledger operation.

The provider-backed (secret) branch is unchanged: those fields never touch the JSONC
layer, are forced to `"default"` by step 3, and so never show a Reset in the pane.

### 5. Settings web — delete the client-side comparison

- [`config-field.tsx`](../plugins/config_v2/plugins/settings/web/components/config-field.tsx):
  delete `stripListIds` and `isFieldModified`, delete the `defaultValue` prop,
  and set `isModified = tier === "user"`. `mapConfigLists` stops being imported.
- [`config-detail.tsx`](../plugins/config_v2/plugins/settings/web/components/config-detail.tsx):
  delete the `defaults` local (line 184; its only two uses are `hasAnyModified` and
  the `defaultValue` prop) and derive
  `hasAnyModified = Object.values(tiers).some((t) => t === "user")`.
- `tiers` is a `z.record`, so `tiers[key]` is `| undefined` under
  `noUncheckedIndexedAccess`. Do **not** paper that over with `?? "default"` — that
  re-introduces "unknown renders as not-modified", the exact collapse this plugin's
  doctrine exists to prevent. The server emits a total map by construction (it
  iterates `descriptor.fields`), so a missing key is a bug: read it through a
  `tierFor(key)` helper in `ConfigDetailBody` that throws, and make `ConfigField`'s
  `tier` prop required and non-optional.

### 6. Make the wrong basis unreachable from this surface

`descriptor.defaults` has to stay on `ConfigDescriptor` — `useConfig` falls back to
it in the pre-hydration window. But the settings pane does not get its descriptors
from `useConfig`; it gets them from `useConfigRegistrations`, and
`ConfigRegistration.descriptor` is the only channel by which `defaults` reaches
these files. Narrow that field to `Omit<ConfigDescriptor, "defaults">` (or a
settings-local view type) so `registration.descriptor.defaults` becomes a `tsc`
error in the settings plugin, permanently — a type error (rung 2) instead of an
absence a future edit can undo with one keystroke.

Verify first that no other consumer of `useConfigRegistrations` reads `.defaults`;
if one does and legitimately needs it, drop this step rather than widening the type
back — the value of the rung is that it admits no exception.

### 7. Docs

- [`config_v2/CLAUDE.md`](../plugins/config_v2/CLAUDE.md) "Derived aggregates":
  modified-counts is no longer event-fed in-memory; state the new definition of
  modified and that conflicts suppress it.
- [`core/internal/resource.ts`](../plugins/config_v2/core/internal/resource.ts)
  `configV2ModifiedCountsSchema`'s comment ("differs from the schema defaults") and
  the `resource.ts:375` block comment above `computeModifiedCount`.
- `settings/CLAUDE.md` — the "is the value modified" bullet in what `ConfigField`
  computes, plus its autogenerated `Uses:` block (dropping `mapConfigLists` changes
  it, and `plugins-doc-in-sync` fails otherwise; `./equin build` regenerates).

---

## Deliberately not in scope

- **The fork-on-write wrinkle.** `writeScopedOriginSnapshot` snapshots base
  *effective* — including the user's base override — into a new scope's origin. So a
  freshly forked app scope reads entirely `"git"` and shows no "Reset all". Under the
  new definition that is correct (nothing has been modified *in that scope* yet), and
  changing it would change fork semantics. Accepted, and worth one comment at the
  snapshot site.
- **Publishing a whole per-field decision from the server.** `ConfigField` still
  receives `value`, `originValue`, `trueConflictKeys` and `tier` and derives
  `hasConflict` client-side, and `classify` in `settings/web/internal/conflict-context.ts`
  derives the same thing a second time. Collapsing both into one server-computed
  per-field state beside `threeWayMerge` is the right end state and a bigger change
  than this one. File it as a follow-up.

---

## Verification

1. `./equin build` (background, `run_in_background: true`), then
   `./equin check` — `type-check`, `plugins-doc-in-sync`,
   `config-origins-in-sync`, `config:overrides-authored`. No `config/**` file may
   change: this touches no origin generation.
2. `./equin test plugins/config_v2` — `tier-resolve.test.ts` and
   `tier-logic.test.ts` must pass **unchanged** (they are the net under step 1), plus
   the new `field-tiers.test.ts`.
3. In the app at `http://<worktree>.localhost:9000`, Settings → config nav:
   - `ui/theme-engine/variant-group` has a committed authored override and no user
     override in this worktree. It must show **no** count badge and no accent stripe,
     and its fields must show the `git` badge. Today it shows a count.
   - Every reorder slot config (`source: "reorder"`) must show no count badge.
   - Change one field, confirm the count appears, the stripe appears on that field
     only (not on its untouched list-field neighbours), and Reset restores the
     committed value rather than emptying it.
   - Reset the last modified field and confirm
     `~/.singularity/state/config/<wt>/<hier>/<name>.jsonc` is gone from disk.
4. `mcp__singularity__query_db` is not useful here (config lives on disk, not in
   Postgres); read the user-layer files directly under
   `~/.singularity/state/config/<worktree>/` to confirm what each step wrote.
