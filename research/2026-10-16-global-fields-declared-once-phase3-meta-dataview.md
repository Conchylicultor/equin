# Fields declared once — Phase 3: the Meta-DataView

Track page: `block-c8dbdc78-50f1-483a-bfbb-02f24825f9e0` (Design v2: `block-5f372b48-…`).
Track instructions: `block-361815ed-5750-413a-b5ab-31c5dc855144`.
Previous: `research/2026-10-13-global-fields-declared-once-phase2.md`, `research/2026-10-15-global-fields-declared-once-phase2b.md`.

## Context

The DataView page's "Meta-DataView" is one list over several kinds of record:

- **shared fields** that every kind has, so one filter or sort means the same thing on every row;
- **per-kind fields**;
- **a source field**, to filter or group by kind.

Its examples are unified events and "long-running tasks (builds, deployments, backups)".

What the code has today:

- **`MergedDataView` is not that.** It is a source switcher: only the active source mounts, rows are never combined, and both of its users (the conversation sidebar's Queue and History, the task deps tree's Deps and Created) list one entity.
- **The `runs` list already is a Meta-DataView.** It is a `liveCollection({ arms })` served as one SQL `UNION ALL` (`serveUnionCollection`). It has shared base fields (`runFields`) and per-arm fields (`liveArm`, ids `<arm>.<field>`, each in its own band). Paging, filter and sort run on the server across every arm, with arm pruning. Data-view derives the base and arm fields with no list code.

What is runs-specific, so a second union would have to copy it:

1. **Binding.** An arm binds its table onto the base fields through `defineRunKind` (`runs/server/internal/registry.ts`). It has a hand-written `RunArmBase` type, a runs-only registry (`getRunKinds`) and the `duration` derivation. `serveUnionCollection` itself is typed loosely (`UnionArmBinding`).
2. **Source field.** `kind` is a plain `textField` declared by hand in `runFields`. Its options come from the runs-only `Runs.Kind` slot (`useRunKindOptions`, `runs/web/internal/presentation.tsx`).
3. **Row activation.** Where a click on a row goes is `Runs.Kind.link`, folded by hand in `RunsDataView`.
4. **Arm fields from an entity.** Every arm restates its fields over a raw ledger table. An arm cannot be declared `from` an entity or extension shape (`pick`, exposed fields), so it cannot reuse fields declared once.

**Decision** (user, 2026-10-16):

- Make the union collection the Meta-DataView primitive, served on the server (no in-browser row union).
- Migrate runs onto it.
- Prove that the primitive is general with test fixtures, an entity-arm union in the golden and the oracle.
- `MergedDataView` keeps its behaviour, renamed so its name stops claiming a row union.
- A real second Meta-DataView over entities is the next task, not part of this one.

## Design

### 1. The source field is derived (network/live core)

The union declares its discriminator with a label, and no longer lists it as a field:

```ts
export const runs = liveCollection("runs", {
  fields: runFields,                      // no `kind` entry any more
  carry: { fields: { runKey: textField(), id: textField() } },
  id: "runKey",
  arms: { discriminator: "kind", label: "Kind" },
  …
});
```

- `liveCollection` adds the discriminator field itself: text, its domain derived (`fieldDomain`), sortable, and `source: true` on its `LiveField` descriptor.
- tsc rejects a `fields` entry named like the discriminator, and so does the runtime (replacing today's check that it *is* a row field).
- **Options are the registered arms.** `deriveFields` (`primitives/data-view/web/internal/derived-fields.tsx`) already collects the union's arms from their `FieldPresentation.Register({ owner: arm })` registrations. It gives the source field `options = arms sorted by order → { value: arm.owner.arm, label: arm.label }`. The registrations are a contribution registry, so the options are always known, never a stand-in.
- **Default cell:** the arm's label as a muted badge. A union can still override it through `FieldPresentation.Register({ owner: union, fields: { kind: … } })`.
- **Deleted:** `useRunKindOptions` and the `kind` entry in `runsPresentation`.

### 2. Arms bind generically, and are registered generically (network/live server)

`defineRunKind`'s typed facade moves into network/live as `serveArm(arm, spec)`:

- The facade's pieces move with it: `TypedJoinRef`, `RunFieldBinding` → `UnionFieldBinding<T, J, V>`, and the per-field value check.
- `spec.base` is typed from the union's base fields: every base field except the id, the discriminator and the union's `derive`d fields. A nullable field may be bound `null`; a non-null one may not.
- `spec.extra` is typed from the arm's own listed fields, minus those an entity arm reads by pick (§3).
- `serveArm` returns a `Registration` into a registry in live server, keyed by union. It throws on a duplicate kind.

```ts
// in the build arm's server
export const buildRunServed = serveArm(buildRunArm, {
  from: _buildRuns, id: _buildRuns.id,
  base: (j) => ({ label: …, outcome: …, trigger: j.base.trigger, … }),
  extra: (j) => ({ status: …, targets: …, commitHash: j.base.commitHash, exitCode: j.base.exitCode }),
  where: (j) => eq(j.base.namespace, runtimeNamespace()),
});

// in runs/server
export const runsServed = serveUnionCollection(runs, {
  derive: { duration: (b) => durationOf(b.startedAt, b.finishedAt) },
});
```

- **Arms come from the registry.** `serveUnionCollection` drops its `arms: () => …` option and reads the arms registered for the collection at the deferred bind.
- **Derived base fields.** `derive` is new: base fields computed from other base bindings. That keeps "no arm supplies `duration`" by construction.
- **Deleted from runs:** `defineRunKind`, `RunArmBase`, `RunKindSpec`, `getRunKinds` and the registry. The four arms (build, release, deploy, backup) call `serveArm` directly.
- **Docs:** the `live:arms-registered` check hint and its comment name `serveArm`.

### 3. An arm can be declared from an entity (network/live core and server)

`liveArm` takes the same field vocabulary as the entity form of `liveCollection`:

```ts
liveArm(activity, "task", {
  label: "Task", order: 10,
  from: tasksEntity,          // or an extension shape
  pick: ["status"],           // listed, labels from FieldMeta
  fields: { … },              // own fields, as today
  carry: { … },
  exposes: true,              // the entity's exposed extension fields join the arm's band
  sortable: ["status"],
});
```

- **Reuse the entity derivation.** It is factored out of `live-collection.ts`: a picked field's descriptor, a label being required, `exposes`. The arm calls it, so `liveCollection` and `liveArm` cannot drift.
- **Server.** In `serveArm({ from: entity, … })`, picked fields bind to the entity's columns automatically, and `extra` covers only own fields (tsc).
- **Exposed fields on an arm.** These compile as LEFT 1:1 joins on the arm's key, with the existing `extension.join` and change routes, like a direct collection exposure (Phase 1). This is the last step, since it touches the union compile and its routing. If it proves heavy, it is the step that splits off.

### 4. Row activation per arm (primitives/data-view)

- **New slot.** `DataViewSlots.CollectionRowActivation({ owner, link })` sits beside `CollectionItemAction`, with the same owner type (a collection, or one arm of a union).
- **Behaviour.** A DataView listing the owner activates each row through its arm's `link`. A list's own `rowActivation` / `onRowActivate` still runs as well, folded the way `RunsDataView` does today. A row whose arm declares no link stays a plain container.
- **Runs:** the fold in `RunsDataView` and `Runs.Kind` are deleted. Each arm contributes `CollectionRowActivation({ owner: xRunArm, link })`.
- **Stays runs-only:** `Runs.Leading` remains the runs list's own glyph seam. It is presentation of one surface, not field vocabulary.

### 5. `MergedDataView` → `DataViewSwitcher`

- **Rename:** the component, its props types, `defineDataViewSources` (→ `defineDataViewSwitcherSources`), and the docs in data-view's CLAUDE.md "Multi-source surfaces". The two consumers are updated, and behaviour is unchanged.
- **Data-view CLAUDE.md gets a "Meta-DataView" section.** A list over several kinds of record is a DataView over a union collection (`arms` + `liveArm` + `serveArm`). It covers:
  - shared fields = the union's base fields;
  - per-kind fields = arm fields;
  - the source field = the discriminator;
  - and why the switcher is not that.

## Steps

1. **Source field** (§1): `live-collection.ts` (union overload and runtime), the `LiveField.source` flag, `deriveFields` options and the default cell. Update `runFields` and `runsPresentation`. Tests: `live-arms.test.ts`, `derived-fields.test.ts` (source options in arm order, override precedence), `runs-data-view.test.tsx`.
2. **`serveArm` + registry + `derive`** (§2) in `network/live/server/internal/serve-union.ts` (or a sibling `serve-arm.ts`). Migrate the four arms, delete the runs registry, update the check hint. The union golden must stay byte-identical (`compile-union-golden.test.ts`) and `serve-union-oracle.test.ts` must stay green.
3. **Entity arms** (§3): factor out the entity derivation, extend `liveArm` and `serveArm`. Fixture: a new two-entity union in `server/testing/` (two `defineEntity` tables with different fields, one with an exposed extension) added to the union golden (a new pinned case, generator updated) and the oracle (filter on a shared field, on an arm field, on the source field, an arm prune).
4. **Row activation** (§4): the new slot, the fold in the DataView host, and runs' arms moved to it, `Runs.Kind` deleted. Extend the test for the existing `CollectionItemAction` owner resolution.
5. **Rename** (§5), plus the docs: data-view CLAUDE.md, live CLAUDE.md (union section: `serveArm`, `derive`, the derived discriminator, entity arms), runs CLAUDE.md.
6. **`./singularity build`**, then verify (below).
7. **Track page:**
   - status, Phase 3 checkbox with sub-items;
   - exit criteria (Meta-DataView covered);
   - Design v2 §3 "MergedDataView" bullet annotated in an agent card;
   - file the next main task: a real second Meta-DataView over entities (e.g. "Recent activity": tasks, conversations and pages by last update), with the page id and `block-361815ed-…`. "Plan first."

## Files

- `plugins/network/plugins/live/core/internal/live-collection.ts`, `live-columns.ts` (`liveArm`), `field-domain.ts` (reuse)
- `plugins/network/plugins/live/server/internal/serve-union.ts` (+ `serve-arm.ts`), `server/testing/compile-union-golden.ts` / `.json` / `gen-compile-union-golden.ts`, `serve-union-oracle.test.ts`
- `plugins/network/plugins/live/check/index.ts` (`live:arms-registered` hint)
- `plugins/primitives/plugins/data-view/web/internal/derived-fields.tsx`, `web/slots.ts`, the DataView host's row-activation fold, `web/components/merged-data-view.tsx` (renamed), `web/internal/define-data-view-sources.tsx`
- `plugins/runs/core/internal/collection.ts`, `runs/server/internal/{registry,served}.ts`, `runs/web/internal/{slots,presentation}.tsx`, `runs/web/components/runs-data-view.tsx`
- Arms: `plugins/{build,release,backup}/plugins/runs-arm/{server,web}/…`, `plugins/apps/plugins/deploy/plugins/deployments/plugins/runs-arm/{server,web}/…`
- Switcher consumers: `conversations/…/conversations-view/plugins/data-view/web/{host.ts,components/conversations-sidebar-data-view.tsx}` and its queue/history sources, `tasks/plugins/task-deps-tree/web/{components/deps-tree-section.tsx,internal/deps-sources.tsx}`

## Verification

- `./singularity test plugins/network/plugins/live plugins/primitives/plugins/data-view plugins/runs`: the union golden is unchanged for runs; there is a new golden case and oracle cases for the entity union.
- `./singularity check`: type-check, `live:arms-registered`, `investigate:failures-registered` (it reads `liveArm` options), plugin-doc sync.
- `./singularity build`, then screenshot `/debug/build` and the build popover's run list (`e2e-harness/e2e/screenshot.ts`):
  - Kind filter options are Build, Release, Deploy, Backup, in that order;
  - Group by Kind works;
  - clicking a build row opens its pane;
  - a backup row stays inert.
- Conversation sidebar (Queue/History) and the task deps tree are unchanged after the rename.

## Risks

- **Byte-identical union golden for runs.** Moving the binding facade must not reorder `base` keys or columns. If it does, regenerate deliberately and explain the diff.
- **Entity-arm exposures in the union compile** (§3, last part): routing per arm through extension joins is new. It is the cut line if the session runs long.
- **The derived discriminator changes `runs`' row type** (`kind` still a string field, now declared by `arms`). Any consumer naming `runFields.kind` moves to the collection's field.

## As landed (2026-10-16)

Deviations from the design above, each for a reason found while building it:

- **§1 — the discriminator stays a declared field.** Not minted by `arms: {
  label }`: the union declares it in `fields` with its label (a LISTED base
  field — tsc `D extends keyof fields`, a runtime throw otherwise), and may
  not declare options (throw). Data-view's `deriveFields` gives it the
  registered arms as options (`sourceField`). Same outcome, no new spec key,
  and the field keeps its place in the author's field order. No `LiveField`
  flag either: the collection's `arms.discriminator` already names it
  (`DataViewRowsCollection.arms`).
- **§2 — `served.arm(arm, spec)`, not a free `serveArm`.** The typed binding
  is a method of what `serveUnionCollection` returns, so the union's row type,
  its id literal (`liveCollection` now keeps `id: I` on the union overload),
  discriminator and derived keys type `base` with no extra generic at the call
  site; the arms are its own registry (no module-level map). `derive` is `{
  reads, bind(reads, { id }) }` — `reads` must be columns (tsc), which is what
  `durationOf` needs (it interpolates them into SQL). Runs derives both `id`
  and `duration`; `defineRunKind`, `RunArmBase`, `getRunKinds` and the runs
  registry are deleted.
- **§3 — `from` / `pick` only; exposures on an arm are NOT in.** An arm picks
  entity (or extension-shape) fields by name, listed with the entity's labels
  (`arm.picked`), and `served.arm` binds the picked ones by name (`extra` may
  omit them — tsc). Folding the entity's EXPOSED extension fields into an arm
  (LEFT joins + routes inside the union compile) is the cut line named in the
  risks; it is a follow-up, needed by the first real entity union.
- **§3 test fixture** — a dedicated compile test
  (`server/internal/serve-union-entity-arms.test.ts`: two entities, picked
  fields bound by name, each arm's routes reading them, a derived field bound
  by an arm refused) rather than a new golden / oracle case: the compile, the
  routing and the SQL are the existing union's, unchanged; only the binding by
  name is new.
- **§4 — `CollectionRowActivation({ id, owner, useActivation })`.** A hook
  (the owner reads its own context, `useOpenPane`), folded one level per
  contribution like `CollectFieldOptions`; the pure fold is
  `web/internal/fold-activations.ts`. Runs' arms use `runLinks(arm, link)`
  (runs/web), its typed wrapper. `Runs.Kind` is deleted; `Runs.Leading` stays.
- **§5 — `defineDataViewSources` keeps its name**: its sources ARE what the
  switcher switches between; only the component (`DataViewSwitcher`, its props
  types and file) is renamed.
