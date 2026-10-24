# Compare against a real app component: `component:` specimens

## Context

The Prototypes **Compare** stage puts a mock beside the real thing it mocks. A
prototype names that thing with `<meta name="mocks" content="<kind>:<ref>">`.
Today there are three kinds, and none of them can show a single element that
lives inside the running app:

- `route:` / `app:` load a whole screen in an iframe. They can't open a popover,
  so for proto-1789901373-oy29 (the "Improve composer field") they would show the
  page *behind* the composer.
- `fixture:` renders one component, but it takes it from the layout-harness
  catalog. That catalog is also the layout-geometry test suite, which renders
  every fixture in a bare page with no plugin runtime, slots or data. The real
  composer's pills and buttons come from slots, so it can't live there.

The goal is to let any plugin show off one of its real components, rendered
**inside the running app** with real slots, config and data. Compare can then
put that component beside a mock with `component:<id>`. The first specimen is
the Improve composer, and proto-1789901373-oy29 declares it.

## Design

Three pieces, one per layer. The plugin that owns a component registers it. The
Compare stage only reads the registry, so it never names a specimen.

### 1. `plugin-meta/specimens` — the registry (new leaf plugin, web only)

A plain `defineSlot`, not a render slot. The consumer picks ONE specimen by id,
so reorder middleware and a reorder config would be meaningless. The precedents
are `HealthReport.Row` (`plugins/shell/plugins/health-report/web/slots.ts`) and
`Runs.Kind`.

```ts
// core/types.ts
export interface SpecimenDef {
  id: string;                 // "<plugin>/<name>", e.g. "task-draft/composer"
  label: string;              // "Improve composer"
  description?: string;
  widths?: readonly [number, ...number[]]; // breakpoints it has something to say about
  component: ComponentType;   // the REAL component, self-contained (holds its own state)
}

// web/slots.ts
export const Specimens = {
  Specimen: defineSlot<SpecimenDef>({ docLabel: (s) => s.id }),
};
```

The barrel also exports `useSpecimen(id)`, which returns a union:
`{ kind: "found", def }`, `{ kind: "missing" }` or
`{ kind: "ambiguous", ids }`. When two plugins claim the same id, the result
says so instead of silently picking one.

**Why this location.** `tasks` must not depend on `apps/prototypes`, so the slot
has to live in a leaf plugin that both can import. CLAUDE.md rules out a new
top-level `primitives/` entry. `plugin-meta` ("plugins about the plugin system:
browsing, inspecting") fits, and a later Studio "Specimens" tab could read the
same registry without any change here.

**The contract a specimen must meet.** A specimen renders standalone at any
width. It holds its own local state. It never submits, navigates or writes to
the database, because it is an exhibit and not a working copy. This is stated
in the plugin's `CLAUDE.md` and in the `SpecimenDef` JSDoc.

### 2. `compare/plugins/component` — the counterpart kind (new plugin)

This mirrors `compare/plugins/fixture`: a new folder with no edit to `compare`
itself (per compare's CLAUDE.md).

```ts
Counterpart.Kind({
  match: "component",
  label: "Live component",
  example: "component:task-draft/composer",
  component: ComponentCounterpart,
})
```

`ComponentCounterpart({ target, meta, children })` maps the lookup to a
resolution:

- `missing` → `unresolved`: "No component `<id>` in this worktree. It may exist
  on another branch." Prototypes are shared by every worktree, so this is an
  ordinary case, the same as with `fixture:`.
- `ambiguous` → `unresolved`, naming the plugins that clash.
- `found` → `found { widths, title: def.label, badge: def.id, render: () => <def.component/> }`.
  The widths are the specimen's own `widths`, merged with the prototype's
  declared viewport width (see `widthChoices` in
  `route/web/components/route-counterpart.tsx`). With no `widths` given, it uses
  the viewport width plus `360 / 640 / 960`.

`loading` is not needed. Slot contributions are synchronous once the plugin has
booted, and the stage is a deferred pane that only renders after that.
(Verify: if specimen contributors can sit in a deferred tier, return `loading`
while `useDeferredLoadState()` is incomplete, as the route kind does.)

`render` runs inline in the app's React tree, inside the stage's `ScaledBox` and
`PluginErrorBoundary`, as `fixture:` does. No kind-specific chrome is needed:
the `data-compare-half` / `data-compare-status` hooks that `e2e/compare-diff.ts`
reads come from the shared `Half`.

### 3. First specimen: the Improve composer (in `tasks/task-draft-form`)

`TaskDraftCard` (`plugins/tasks/plugins/task-draft-form/web/components/task-draft-card.tsx`)
mixes two things. One is the chain-card chrome: `useSortable`, the drag handle
and the remove button in the corner. The other is the composer itself: the
`ComposerField` with its URL attach toggle, the `TaskDraftFormSlots.Action`
buttons (the element picker), and the launch-option pills. The `useSortable` call
is why a standalone card would need a fake `DndContext`.

- **Split it.** Extract `TaskDraftComposer` (the `ComposerField` plus
  `CardBarStart` / bar end) from `TaskDraftCard`. `TaskDraftCard` keeps the
  sortable shell and renders `<TaskDraftComposer …/>` inside it, so the popover
  is unchanged. The composer then has no dnd-kit dependency.
- **Add `ImproveComposerSpecimen`** (web/components/composer-specimen.tsx). It
  holds `text`, `launchOptions` and `includeUrl` locally, seeding them from
  `useLaunchOptionDefaults()` (`tasks/launch-options/web`) and the plugin's own
  `useCaptureUrlDefault()`. It passes a no-op submit. It renders
  `<TaskDraftComposer isHead …/>`, with no relate props, so there is no
  dependency pill, matching the Improve popover.
- **Register it** in `task-draft-form/web/index.ts`:
  `Specimens.Specimen({ id: "task-draft/composer", label: "Task composer (Improve)", widths: [360, 480, 640, 900], component: ImproveComposerSpecimen })`.

  The specimen stays inside its owning plugin, so there are no deep imports.
  `TaskDraftCard` and `TaskDraftComposer` stay private.

The element-picker button, the model/thinking/preprompt pills and the URL
toggle all show up on their own. They are global slot contributions (the report
confirmed that `LaunchOptionPills` and `TaskDraftFormSlots.Action` need no
provider beyond plugin boot).

### 4. The prototype

Add `<meta name="mocks" content="component:task-draft/composer" />` to
`~/.singularity/apps/prototypes/proto-1789901373-oy29/index.html`. It is outside
the repo, and its turn is versioned automatically. This is the only line
touched in that folder.

## Files

- New `plugins/plugin-meta/plugins/specimens/{package.json,CLAUDE.md,core/{index.ts,types.ts},web/{index.ts,slots.ts,use-specimen.ts}}`
- New `plugins/apps/plugins/prototypes/plugins/compare/plugins/component/{package.json,CLAUDE.md,web/{index.ts,components/component-counterpart.tsx}}`
- Edit `plugins/tasks/plugins/task-draft-form/web/components/task-draft-card.tsx` (extract the composer)
- New `plugins/tasks/plugins/task-draft-form/web/components/{task-draft-composer.tsx,composer-specimen.tsx}`
- Edit `plugins/tasks/plugins/task-draft-form/web/index.ts` (the contribution) and its `CLAUDE.md`
- Edit `plugins/apps/plugins/prototypes/plugins/compare/CLAUDE.md` (kinds list: add `component`) and `prototypes/CLAUDE.md` (the `mocks` kinds list: add `component:`)
- Registries and plugin docs regenerate through `./equin build`

## Out of scope / follow-ups

- **Specimen variants.** The mock has `fill: empty | filled` and
  `context: both | url-only` options. A specimen could declare `variants`, and
  the kind could surface them through `found.controls` (as `version:shown` does
  with its Variant picker). That is a follow-up, once a second specimen shows
  what shape it needs.
- **A Studio or Debug "Specimens" gallery** reading the same slot.
- Whether `fixture:` should eventually become a specimen source, since a layout
  fixture is a specimen with invariants attached.

## Verification

1. `./equin build` (in the background). Checks pass: plugin boundaries,
   registry in sync, plugin docs in sync, type-check.
2. Open the Improve popover in the deployed worktree and confirm it looks and
   behaves the same (typing, pills, URL toggle, pick element, drag and remove
   with 2+ cards).
3. Compare stage for proto-1789901373-oy29:
   `./equin run plugins/apps/plugins/prototypes/plugins/compare/e2e/compare-diff.ts --name proto-1789901373-oy29 --width 900 --out <scratchpad>/compare`
   The counterpart half should reach `found`, and its capture should show the
   real composer with model/thinking/preprompt pills and the URL and
   element-picker buttons.
4. A missing id: temporarily point a scratch prototype at `component:nope/x` and
   check that the half is `unresolved` with the "no component" sentence.
5. Unit test for `ComponentCounterpart`'s mapping from lookup to resolution
   (missing, ambiguous, found, and widths merging), as a jsdom test under
   `component/web/__tests__/`, run with `./equin test`.
