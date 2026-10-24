# Fix B — push/build repo-tree codegen parity (single source of truth)

Status: **implemented** (uncommitted in this worktree, for review). Sibling: **Fix A**
(`research/fix-a-deterministic-slots-scan.md`) made the reorderable-slots scan a pure,
deterministic function of committed source. Fix B builds on top: it makes
`./equin push`'s post-rebase normalize step regenerate the **same** repo-tree
codegen artifact set as `./equin build`, via a single shared pipeline, so a full
build immediately after a push is a genuine no-op and push-time checks catch all
manifest drift.

---

## 1. The parity gap (root cause)

`push` runs `regen-generated` as its post-rebase normalize step. Before Fix B that
command regenerated only **four** of the repo-tree codegen artifacts:

- barrel stubs
- plugin registry
- plugin docs (compact / details / per-plugin CLAUDE.md autogen blocks)
- config origins

The full `./equin build` additionally regenerates three repo-tree manifests that
`regen-generated` skipped:

- `generateReorderableSlots` → `plugins/reorder/shared/reorderable-slots.generated.ts`
- `generateDataViews` → `plugins/primitives/plugins/data-view/shared/data-views.generated.ts`
- `generateTokenGroupVars` → `plugins/framework/plugins/tooling/plugins/checks/core/token-group-vars.generated.ts`

…and only then ran `generateConfigOrigins` **last**.

Two consequences:

1. **Push could commit a tree the next full build does not reproduce.** If a merge
   changed the reorderable-slot / data-view / token-group set, the committed manifest
   stayed stale through normalize → the next full build on `main` rewrote it → `main`
   went dirty / the in-sync checks failed *after* the push had already landed.
2. **Stale origins.** `regen-generated` ran `generateConfigOrigins` *without* first
   running `generateReorderableSlots`, which registers the per-slot config_v2 directives
   (and installs the reorder contribution catalog as the default origin-annotations /
   origin-defaults preparer). So even the origins it regenerated could be computed
   against a stale directive set.

The gap was introduced by **duplicating** the codegen call list across `build.ts` and
`regen-generated.ts` and letting them drift — exactly the failure mode CLAUDE.md's top
rule warns against ("fix the structural issue, not the specific instance").

### Out of scope (deliberately excluded from the parity set)

- **DB migrations** (`generateMigration`) — stateful, build-only, handled by its own
  build step.
- `writeCentralRoutesManifest`, `central.json`, `propagateConfigToUser` — these write
  under `~/.singularity/`, NOT the repo tree, so they are not "repo-tree codegen" and
  must not run in the worktree normalize step.

---

## 2. Design — one shared, ordered pipeline

Extract the full ordered, non-migration **repo-tree** codegen sequence into the codegen
core barrel as the single source of truth. New module
`plugins/framework/plugins/tooling/plugins/codegen/core/regen-pipeline.ts` exports two
functions (split to preserve build's interleaving of DB/central steps):

- `regenerateRegistryCodegen({ root, onStep? })`
  → barrel stubs → plugin registry.
  Runs FIRST in build (before central spawns + before migrations).
- `regenerateManifestCodegen({ root, onStep? })`
  → plugin docs → reorderable-slots → data-views → token-group-vars → **config-origins (LAST)**.
  Runs in build AFTER migrations.

`regen-generated` runs both back-to-back.

**Authoritative ordering record** (carried as comments in `regen-pipeline.ts`):
- plugin docs FIRST — builds the enriched plugin tree the next two steps reuse.
- reorderable-slots & data-views — AFTER docs (reuse the enriched tree), BEFORE origins
  (they register the config_v2 directives origins depend on; importing the codegen barrel
  also installs the reorder per-slot contribution catalog as the default
  origin-annotations preparer, so origins carry the catalog comments).
- token-group-vars — before the build-time CSS single-owner checks consume it.
- config-origins — LAST (depends on every directive registered above).

### Preserving build's per-step profiler granularity

The build profiler (`plugins/framework/plugins/cli/bin/profiler.ts`) lives in the CLI
plugin and can't be imported by codegen core (boundary). So the pipeline accepts an
optional `onStep: CodegenStep` wrapper:

```ts
export type CodegenStep = (id: string, label: string, run: () => Promise<void>) => Promise<void>;
```

`regen-generated` omits it (runs each step inline). `build.ts` passes a `codegenStep`
that wraps each step in `buildProfilerStart(id, phase, label)` — preserving every span id
(`barrelStubs`, `pluginRegistry`, `pluginDocs`, `reorderableSlots`, `dataViews`,
`tokenGroupVars`, `configOrigins`) and the historical phase mapping (`pluginDocs` →
`build:validation`, all others → `build:codegen`).

---

## 3. Files changed

- **`plugins/framework/plugins/tooling/plugins/codegen/core/regen-pipeline.ts`** (new) —
  the shared pipeline (`regenerateRegistryCodegen`, `regenerateManifestCodegen`,
  `CodegenStep`, `RegenCodegenOptions`) with the authoritative ordering comments.
- **`plugins/framework/plugins/tooling/plugins/codegen/core/index.ts`** — re-export the
  pipeline helpers + types from the codegen core barrel.
- **`plugins/framework/plugins/cli/bin/commands/regen-generated.ts`** — replace the four
  inline generator calls with `regenerateRegistryCodegen` then `regenerateManifestCodegen`;
  updated `.description()` to list the now-covered manifests and note build-parity.
- **`plugins/framework/plugins/cli/bin/commands/build.ts`** — replace the two inline
  generator blocks with the two helpers (same order); thread a `codegenStep` profiler
  wrapper; keep all interleaved DB/central/migration steps and the
  `propagateConfigToUser` step where they were; drop the now-unused individual generator
  imports.
- **autogen refresh** (by build): `plugins/framework/plugins/tooling/plugins/codegen/CLAUDE.md`
  (new exports), `docs/plugins-details.md`.

(Fix A's files — `reorderable-slots-scan.ts`, `reorderable-slots-scan.test.ts`,
`reorderable-slots-gen.ts`, and its doc churn — are present in this worktree and were left
intact; Fix B builds on top of the deterministic scan.)

---

## 4. The one-build-lag ordering question — resolution: **leave order as-is, documented**

Fix A flagged that build runs `generatePluginDocs` BEFORE `generateReorderableSlots`, so
when the slot set changes, that build's reorder `ConfigV2.WebRegister` doc count reflects
the OLD manifest and self-corrects only on the next build.

**Investigated whether a single-pass fix is possible. It is not, cleanly, in Fix B's
scope — here is why:**

- The reorder doc count comes from the **reorder web barrel's `def.contributions`**
  (`plugins/reorder/web/internal/config-registrations.ts` → `reorderConfigContributions`,
  one entry per row of `reorderableSlots` imported from the committed manifest file).
- Docs read that barrel via the **memoized enriched plugin tree**
  (`buildEnrichedTree`, `docgen.ts:136-145`), which imports each barrel exactly **once**
  per process via dynamic `import()` (`plugin-tree.ts:330` → `importBarrel` →
  `await import(barrelPath)`).
- Dynamic `import()` is cached by the JS module registry. Once the reorder barrel (and
  its `import` of `reorderable-slots.generated.ts`) has evaluated, **rewriting the
  manifest file on disk does not re-evaluate the module.** `collectReorderableSlots` also
  shares that same memoized tree (it needs the runtime contributions facet for the
  origin *catalog* — only the slot SET is static after Fix A).

Therefore reordering the codegen steps within a single process **cannot** make docs
reflect a freshly-written manifest: the barrel's manifest read is frozen at first import,
and the enriched tree is built once and shared. A true single-pass fix would require
either (a) re-spawning a fresh process for docs after the manifest write, or (b) deriving
the reorder doc count from Fix A's static slot scan instead of the imported barrel
(Fix A §3.2 "preferred" option, which Fix A explicitly deferred — it touches the
contributions facet and risks the collection-consumer abstraction). Both are out of
Fix B's scope and the task says to leave the order as-is and document when a single-pass
fix is risky or violates a real dependency.

**Does the lag break the no-op guarantee Fix B is about?** In the steady state (a clean,
already-built tree — which is what a developer pushes), it does not: the committed
manifest and docs are mutually consistent at that tree's slot set, so a build/normalize
re-run is a byte-for-byte no-op (proven in §5). The lag only manifests on the single
build/normalize pass that *changes* the slot set, and self-corrects on the next pass.
Fix B does not make this worse — it inherits the pre-existing, bounded one-pass lag —
and it strictly **closes** the much larger parity gap (the three skipped manifests +
origins ordering). The residual one-pass reorder-doc lag is recorded here as the natural
follow-up for whoever picks up Fix A §3.2.

> **Follow-up (out of scope):** tie the reorder `ConfigV2.WebRegister` doc count to the
> static slot scan (Fix A §3.2 preferred) so docs reflect the fresh slot set in the same
> pass, eliminating the residual one-pass lag entirely.

---

## 5. Verification (all green)

1. **Build-is-a-no-op (double build).** `./equin build` → exit 0. A second
   `./equin build` on the already-built tree left the diff **unchanged** (326 →
   326 lines). The pipeline is idempotent across full builds.
2. **Push normalize parity (`regen-generated`).**
   - On a clean (already-built) tree, `bun …/cli/bin/index.ts regen-generated` is a
     **no-op** (identical 326-line diff, same file set) — it now reproduces exactly what
     build produced.
   - **Touch-and-restore:** corrupting each of the three previously-skipped manifests
     (`reorderable-slots.generated.ts`, `data-views.generated.ts`,
     `token-group-vars.generated.ts`) and running `regen-generated` **restored each to its
     correct value** (sha round-trip confirmed). Before Fix B these survived
     `regen-generated` untouched — proving the parity gap is closed.
3. **`./equin check`** — exit 0, every check `ok`. Specifically green and in the
   default set: `reorderable-slots-in-sync`, `data-views-in-sync`, `token-group-vars-in-sync`,
   `plugins-doc-in-sync`, `config-origins-in-sync`, `plugins-registry-in-sync`,
   `barrel-stubs-in-sync`, `type-check`. Each of the three newly-covered manifests has its
   own in-sync check in the default set (no gap).
4. **Unit test.** `bun test …/reorderable-slots-scan.test.ts` → 6 pass / 0 fail (Fix A's
   scan, which the pipeline depends on, still deterministic under the new wiring).

### Idempotency / safety confirmed

- All three newly-covered generators are static scans / `importBarrel` reads over the
  committed plugin tree (the same machinery `generateConfigOrigins` already exercised in
  the old `regen-generated`), and each writes with an equality guard. They need no running
  server, DB, or built frontend — safe to run in the worktree during push.
- `node_modules` is present before normalize runs (push does `bun install
  --frozen-lockfile` before normalize; build's step 1 is `bun install`). No build-only
  state is required by the expanded set.

---

## 6. Surprising / uncertain

- The one-build-lag is **structurally unfixable by reordering** because of the JS
  module-registry caching of the reorder barrel's manifest import (§4). This is the only
  notable subtlety; it is bounded, pre-existing, and recorded as a follow-up rather than
  worked around.
- Everything else was mechanical: the three generators were already deterministic and
  guard-on-equality, so folding them into the shared pipeline was a clean lift.
