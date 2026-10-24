# Seeded authored overrides — killing the two-build slot ceremony

## Context

Adding a `defineRenderSlot` today costs a **build → fail → author → rebuild** loop, and an
agent that cannot build cannot produce the required files at all. Hit while adding the
`ConfigDetail.Action` slot (`plugins/config_v2/plugins/settings/web/internal/detail-action-slot.ts`).

The chain that makes it impossible to discharge in one pass:

1. Every `defineRenderSlot` is reorderable, so it owes a committed override at
   `config/<asPath(pluginId)>/<slotId>.jsonc` (`reorder:configs-authored`,
   `plugins/reorder/check/index.ts` — `alwaysRun`, so it fails even `--skip-checks` builds).
2. That override must carry a `// @hash <12hex>` header (`config-origins-in-sync`
   hard-fails a missing one) matching `computeHash(<slot>.origin.jsonc content)`.
3. The origin's `items` default is the **materialized live contribution catalog**, built by
   `setDefaultOriginDefaultsPreparer` in `codegen/core/reorderable-slots-gen.ts` via a
   barrel-importing enriched tree walk, then run through a custom 48-bit multiply-xorshift
   hash (`plugins/config_v2/core/internal/config-proxy.ts`).

So the hash is **un-hand-computable pre-build** — it depends on a barrel walk. The author is
told to "copy `.origin.jsonc` → `.jsonc`", but the origin does not exist until a build has
already failed the check that demands it.

The invariant is sound and stays: a slot's on-screen order must be a deliberate, committed
layout, not the natural load order. What is wrong is the **split of labour**. The recipe has
a mechanical half (produce the file, copy the catalog, transcribe the hash) and a judgment
half (arrange the items for how the slot actually renders). Today a human does both, and the
mechanical half is the part that forces the extra build cycle — even though the build is the
only thing that *can* do it.

Look at the real artifact this ceremony produced —
`config/config_v2/settings/config-detail.action.jsonc` — its JSON body is **byte-identical**
to its origin. Two build cycles bought a file whose only human content is rationale comments.

**Intended outcome:** the build performs the mechanical half; the human performs the judgment
half. One build, no hash transcription, no path guessing.

## Design

### 1. `requiresAuthoredOverride` — a descriptor declares its override is mandatory

`plugins/config_v2/core/internal/define-config.ts`

```ts
defineConfig({
  name: slotId,
  requiresAuthoredOverride: {
    guidance: [
      'Arrange "items" for how this slot renders (sidebar = vertical list,',
      "toolbar = horizontal bar, pane = stacked blocks).",
    ],
  },
  …
})
```

Optional; absent means today's behaviour (override optional). Carried on `ConfigDescriptor`
(`config_v2/core/internal/types.ts`).

`guidance` is **descriptor-supplied prose**, so the generic engine never names reorder or
data-view — each family owns its own instructions. This is the collection-consumer rule:
adding a third family that owes an authored override requires zero edits to the engine.

Two consumers, both existing today with hand-rolled equivalents:

- `plugins/reorder/shared/directive.ts` → `reorderDirectiveDescriptor`
- the data-view `views` descriptor (owner of `data-view:configs-authored`,
  `plugins/primitives/plugins/data-view/check/index.ts`)

### 2. Codegen seeds the mechanical half

In `generateConfigOrigins` (`codegen/core/config-origin-gen.ts`), after the origin write loop:
for each rendered origin whose descriptor sets `requiresAuthoredOverride`, if the sibling
`<name>.jsonc` is **missing**, write it as the origin's bytes verbatim — same `// @hash`, same
body, same legend comments — with a marker block inserted after the hash header:

```jsonc
// @hash 6e2dcb8b8125
// @review — seeded, not authored. Delete this line once the values below are deliberate.
// Arrange "items" for how this slot renders (sidebar = vertical list,
// toolbar = horizontal bar, pane = stacked blocks).
{
  "items": [ … full catalog … ]
}
```

Write-**if-missing** only. An existing override is never touched — no laundering of
hand-authored bytes, and the "build and `regen-generated` reproduce identical trees"
invariant holds (both run the same seeding; it is idempotent).

Marker is exactly one line matching `/^\/\/ @review\b/m`. Guidance lines below it are
ordinary comments the author may keep or delete.

**Re-marking on update.** The same pass re-inserts the marker into an *existing* committed
override whose `// @hash` no longer matches its origin — i.e. the default moved under it
(a contribution added/removed shifts the materialized catalog, which shifts the hash).

This is the load-bearing half. Today a stale hash fails `config-origins-in-sync` with
`set // @hash <expected> to acknowledge` — which hands over the remedy and teaches
hash-retyping as the fix. Retyping the hash is *acknowledgement*, not review: the new
contribution is still absent from `items`, so `applyTree` appends it at the end in natural
order — an unreviewed default, landed. Re-marking converts that into the same one gate as
creation: the marker must be deleted, and deleting it is a claim that the values below are
deliberate.

Both events therefore route through **one** condition. There is no path — creation or
update — on which an unreviewed default reaches a commit.

Re-marking **also re-stamps the hash**, and the two must go together. Marker without re-stamp
leaves `config-origins-in-sync` failing on the stale hash as well — two failures for one
event, and the agent still has to transcribe a hash. Re-stamping *alone* would be the rejected
sentinel (silently silencing a staleness gate). Paired, they are strictly stronger than
today: a value-transcription gate ("retype this hash to acknowledge") becomes a review gate
("these values are now deliberate"), and the transcription step disappears entirely.

This inverts the usual danger. Stamping is only unsafe when it *closes* a gate; here it is
issued together with a marker that *opens* a louder one, is build-only, and can never land
(§5). Adding a marker is fail-closed — it can cause a check failure, never silence one.

Codegen holds both sides of the change (the committed override body and the freshly
materialized catalog), so it writes the **delta into the marker's guidance lines**:

```jsonc
// @hash 91a4c0b7e2f1
// @review — the catalog changed under this file: +apps.foo:bar, -baz:qux.
// Place the new entries deliberately, then delete this @review line.
```

The check stays a dumb marker scan — it never computes a delta, never knows a family.

Both seeding and re-marking live in a **build-only** module, never in the shared
`regenerateManifestCodegen` pipeline — `regen-generated` runs inside push's merge-driver path
followed by `git add -A && git commit --amend`, so a marker minted there would land unreviewed.
`regen-generated` asserts marker-free instead (§5).

### 3. One generic check replaces two bespoke ones

New `config:overrides-authored` (in `plugins/config_v2/check/index.ts`), replacing **both**
`reorder:configs-authored` and `data-view:configs-authored`.

It is a **pure filesystem scan** of `config/**/*.jsonc` (excluding `*.origin.jsonc`) for the
`@review` marker. No barrel walk, no manifest import, no `git ls-files` spawn — strictly
cheaper than either check it replaces, which matters because it keeps `alwaysRun: true`
(the obligation is codegen-coupled; it must fail `--skip-checks` builds too).

Failure message echoes the file's own guidance lines, so it is self-describing without the
check knowing any family.

Why a presence check is no longer needed: seeding makes absence self-healing. Delete a
required override and the next build re-seeds it *with a marker* — which fails. Presence and
review collapse into one condition, and the condition that survives is the one that carries
meaning.

This also fixes a latent hole on the data-view side: its check tested **presence**, so a
`{"views": []}` file passed while the DataView rendered "No views configured" at runtime.
The marker tests *review*, which is the real requirement.

`cacheSignature: () => null` is retained (the marker is working-tree state).

### 4. Zero-build discovery: `reorderable-slots-in-sync` names the owed path

`checks/plugins/reorderable-slots-in-sync/check/index.ts` already renders the fresh
barrel-free slot set to diff it against the committed manifest. Extend its failure message to
list, for each slot in the rendered set but absent from the committed one, the override path
it owes (`config/${asPath(pluginId)}/${slotId}.jsonc`).

Zero added cost, and a bare `./equin check` (no build) now names exactly what is coming.

> Deliberately **not** done: retargeting `reorder:configs-authored` to scan live source. That
> would pull the codegen barrel — and its load-time `setDefaultOriginDefaultsPreparer` side
> effect — into an `alwaysRun` check, adding an uncached ~5,800-file facet tree walk to every
> `./equin check`. The in-sync check already computes that set and is cacheable.

### 5. `regen-generated` asserts marker-free

`plugins/framework/plugins/cli/bin/commands/regen-generated.ts` runs inside push's
merge-driver path, which is followed by `git add -A && git commit --amend`
(`cli/bin/commands/push.ts`). After the pipeline, fail loudly if any `config/**/*.jsonc`
carries an `@review` marker, rather than amending an unreviewed seed into a landing commit.
Makes "a seeded-but-unreviewed override can never land" structural rather than a
check-ordering accident.

## Resulting flow (the `ConfigDetail.Action` repro)

```
1. write detail-action-slot.ts  →  defineRenderSlot("config-detail.action")
2. ./equin build
     • manifest regenerated pre-barrel  → reorderable-slots-in-sync passes
     • config-detail.action.origin.jsonc written
     • config-detail.action.jsonc SEEDED (real hash, full catalog, @review marker)
     • checks → config:overrides-authored FAILS, naming that exact path + guidance
3. edit the file: arrange items, add rationale, delete the @review line
4. ./equin check config:overrides-authored   → green (seconds)
```

**Still two build cycles** — build #1 aborts on the marker, exactly as it aborts today on the
missing override. The build count is not what this buys, and the earlier draft of this plan
claimed otherwise in error.

What it buys: step 3 collapses from four sub-steps to one (open, arrange, delete a line — no
locating the origin, no copying, no hash), and its two failure modes become structurally
impossible. A mistyped path used to get the file silently `unlink`ed by
`pruneOrphanedConfigFiles`; a mistyped hash used to buy a third cycle. Neither can occur when
the file is machine-produced at the right path with the right hash.

A variant that seeds *without* a marker would make build #1 pass and genuinely cut a cycle,
deferring review to the next catalog shift. It is **rejected**: it lets an agent commit an
unreviewed default for a new slot, which is the exact failure this plan exists to prevent.

> Known ergonomic cost, worth a follow-up: because the marker blocks the **build**, the agent
> cannot deploy and *look* at the slot before curating its order — and order is a visual
> judgment. The fix is a `Check.blocks?: "build" | "push"` axis so the marker gates submission
> rather than deployment (build #1 deploys → look → curate → push). That is a new selection
> axis on `Check` (which deliberately has exactly one today, `scope`), so it is deferred
> rather than folded in here.

## Explicitly out of scope: zero-build authoring

This does **not** let an agent add a slot with no build at all. Closing that would require a
hand-authorable placeholder hash, which was designed and rejected — it is the wrong trade:

- `// @hash new` fails `HASH_RE = /^\/\/ @hash ([a-f0-9]+)\n/` at **nine** parse sites,
  selecting the fail-open class: `tier-logic.ts` treats a null hash as *never stale* (the
  unreviewed override wins forever, `hasConflict` false), while
  `config_v2/server/internal/jsonc-proxy.ts` **throws** on a server read and the
  `composition-closure` check throws a stack trace instead of a hint.
- A reserved hex sentinel avoids that, but `.gitattributes` routes `config/**/*.origin.jsonc`
  through the `regen-generated` merge driver, and push amends its output — so a committed
  sentinel gets stamped into the landing commit **with no local build**, defeating the point
  and silently laundering an unreviewed override.
- Guarding that needs a per-file `git show HEAD:<path>` body-diff (135 override files), which
  is both too strict (it hard-fails the legitimate "catalog shifted, reconcile the override"
  case) and bypassable.

Every codegen-coupled artifact in this repo has the same property — migrations, the plugin
registry, docs, config origins all require a build. A slot is not special, and the repo
workflow mandates `./equin build` after changes regardless.

## Files to change

| File | Change |
|---|---|
| `plugins/config_v2/core/internal/define-config.ts` + `types.ts` | `requiresAuthoredOverride?: { guidance: string[] }` on `defineConfig` / `ConfigDescriptor` |
| `plugins/config_v2/core/index.ts` | export the marker constant + `hasReviewMarker()` helper |
| `plugins/framework/plugins/tooling/plugins/codegen/core/config-origin-gen.ts` | seed pass in `generateConfigOrigins`, after the origin write loop, before `pruneOrphanedConfigFiles` |
| `plugins/config_v2/check/index.ts` (new) | `config:overrides-authored` marker scan |
| `plugins/reorder/check/index.ts` | **delete** (+ `check/grandfathered-slots.ts`, already empty) |
| `plugins/primitives/plugins/data-view/check/index.ts` | **delete** |
| `plugins/reorder/shared/directive.ts` | set `requiresAuthoredOverride` + guidance |
| data-view `views` descriptor | set `requiresAuthoredOverride` + guidance (its current rich hint prose moves here) |
| `checks/plugins/reorderable-slots-in-sync/check/index.ts` | name owed override paths for newly-added slots |
| `plugins/framework/plugins/cli/bin/commands/regen-generated.ts` | assert marker-free |
| `plugins/reorder/authoring-overrides.md` | rewrite for the seeded flow |
| `plugins/framework/plugins/web-sdk/CLAUDE.md` | note the one-build slot recipe |

Existing 135 committed overrides carry no marker → they pass unchanged; no migration needed.

## Verification

1. **Repro the original pain, then confirm it is gone.** On a scratch branch, delete
   `config/config_v2/settings/config-detail.action.jsonc` and run `./equin build`.
   Expect: the file is re-seeded with the correct `// @hash 6e2dcb8b8125`, a body identical to
   its origin, and an `@review` marker; `config:overrides-authored` fails naming that path.
   Delete the marker line, run `./equin check config:overrides-authored` → green.
   Restore the original file with `git checkout`.
2. **A genuinely new slot, end to end.** Add a throwaway `defineRenderSlot` in a scratch
   plugin, run `./equin build` once, remove the marker, run `./equin check`.
   Confirm one build cycle total and that `reorderable-slots-in-sync` named the owed path.
3. **Zero-build discovery.** With the new slot written but before any build, run
   `./equin check reorderable-slots-in-sync` and confirm it prints the owed
   `config/<tree>/<slot>.jsonc` path.
4. **No regression on the existing tree.** `./equin check` on a clean tree — all 135
   overrides pass, `config-origins-in-sync` unaffected.
5. **Seeding is idempotent and never clobbers.** Run `./equin build` twice; confirm the
   second run leaves every override byte-identical (`git status` clean).
6. **Marker cannot land.** With a marker present, confirm `./equin check` fails, and
   unit-test the `regen-generated` assertion.
7. **Unit tests.** Extend
   `plugins/framework/plugins/tooling/plugins/codegen/core/config-origin-gen.test.ts`:
   seeds when missing; leaves an existing override untouched; does not seed descriptors
   without `requiresAuthoredOverride`. A scoped `@app/<id>/` delta is **never seeded** (it is
   an optional per-app delta, not a mandatory override) but IS re-marked when stale, anchored
   to the **base** origin hash via `configFileOwner` — no scoped origin is ever committed.
   Run with
   `bun test plugins/framework/plugins/tooling/plugins/codegen/core/config-origin-gen.test.ts`.
