# ST2 — View-type registry generalization (data-view)

> Sub-task ST2 of the unified view-switcher roadmap
> ([`research/2026-06-15-global-unified-view-switcher.md`](./2026-06-15-global-unified-view-switcher.md)).
> ST1 (the shared `view-switcher` chrome primitive) has landed.

## Context

`data-view` resolves its views by treating each `DataViewSlots.View`
contribution as **both** a view-type *and* the single instance of it. The
contribution is keyed by `id` (`"table"`, `"gallery"`, …); the host iterates
contributions directly, the switcher selects by contribution id, and
`useViewState`/localStorage/config are keyed by that same id. There is exactly
**one instance per registered type**, hard-wired.

The roadmap's end state (ST3–ST4) is **named view instances**: N config-declared
instances, each referencing a view-type by `type` and carrying its own saved
sort/filter/options — Notion's "Todo / Board / Done". That requires separating
two concepts the code currently conflates:

- **view-type** — the registered renderer (`table`, `gallery`, …): title, icon, component.
- **view-instance** — a named, ordered, individually-configured *use* of a view-type.

ST2 introduces that separation as a **pure refactor with zero behavioral or
visual change**. It normalizes the registry contribution shape and inserts a
*default-instances resolver* that synthesizes exactly one instance per resolved
view-type (`id === type`, `name === title`) — reproducing today's behavior while
giving ST3/ST4 a stable seam to hang the config-driven instance list on. This
de-risks the riskiest sub-task (ST3) by landing the data-model split independently
of config persistence.

Scope guard (from the roadmap): 2a lives **entirely inside `data-view`**. No new
plugin, no config, no `FieldDef`/rows coupling in the resolver. The 4 public
`<DataView>` props (`views`, `defaultView`, `viewOptions` — all string-keyed by
type id) are **unchanged**, so the 8 call sites need zero edits.

## Changes

### 1. Normalize the registry contribution shape — `web/slots.ts`

Rename the view-type identity field `id` → `type` and forward-declare the
per-instance options schema (declared, unused until ST3 — declaring it now
stabilizes the contribution shape so ST3 doesn't re-churn the slot type + all 4
children + docs a second time):

```ts
import type { FieldsRecord } from "@plugins/config_v2/core"; // already a data-view dep

export interface DataViewContribution {
  /** Registry id of this view-type (e.g. "table", "gallery"). Instances
   *  reference it via ViewInstance.type. */
  type: string;
  title: string;
  icon: ComponentType<{ className?: string }>;
  order?: number;
  /** This view requires `DataViewProps.hierarchy`; the host drops it when absent. */
  hierarchical?: boolean;
  /** ST3: per-instance `options` sub-form schema, type-dispatched by `type`.
   *  Declared here to fix the contribution shape; unused in ST2. */
  configSchema?: FieldsRecord;
  component: ComponentType<DataViewRenderProps<unknown>>;
}
```

### 2. Add the view-instance core type — `core/internal/types.ts` (+ both barrels)

```ts
/**
 * A named instance of a registered view-type. ST2 synthesizes one default
 * instance per resolved view-type (id === type, name === title); ST3+ replaces
 * the synthesis with a config-authored instance list.
 */
export interface ViewInstance {
  /** Instance identity — the localStorage active-id + switcher selection key.
   *  Default-instances set this equal to the view-type `type`. */
  id: string;
  /** Switcher display label. Default-instances use the view-type `title`. */
  name: string;
  /** Registry id (`DataViewContribution.type`) this instance renders. */
  type: string;
  /** Opaque per-instance options forwarded to the view-type component
   *  (= today's `viewOptions[type]`). */
  options?: unknown;
}
```

Export `ViewInstance` from `core/index.ts` and re-export from `web/index.ts`
(mirrors the existing type re-export block).

### 3. Default-instances resolver — new `web/internal/resolve-instances.ts`

A pure hook that absorbs today's `available` resolution from `data-view.tsx`
(lines 66–81) and emits resolved instances paired with their view-type. It is
**data-view-agnostic** (knows only contributions + the `views`/`hierarchy`/
`viewOptions` inputs — never `FieldDef`/rows), per the roadmap's "design the
resolver extractable from day one".

```ts
export interface ResolvedViewInstance {
  instance: ViewInstance;
  viewType: SealContributions<DataViewContribution>;
}

export function useResolvedInstances(
  contributions: SealContributions<DataViewContribution>[],
  views: string[] | undefined,
  hasHierarchy: boolean,
  viewOptions: Record<string, unknown> | undefined,
): ResolvedViewInstance[]
```

Behavior (identical to current `available`, then 1:1 synth):
1. Drop `hierarchical` view-types when `!hasHierarchy`.
2. If `views` given → resolve each id in order, drop misses; else sort by
   `order ?? 0` then `title.localeCompare`.
3. For each resolved view-type, synthesize
   `{ id: type, name: title, type, options: viewOptions?.[type] }` and pair it
   with the contribution. `useMemo` keyed on the inputs.

### 4. Route the host through instances — `web/components/data-view.tsx`

- Replace the `available` / `viewIds` memos with
  `const resolved = useResolvedInstances(contributions, views, !!hierarchy, viewOptions)`.
- `instanceIds = resolved.map(r => r.instance.id)` → pass to
  `useViewState(storageKey, instanceIds, defaultView)` (unchanged — `_viewIds`
  is already ignored).
- Active resolution by **instance id** (same fallback chain): active instance =
  `byId(activeViewId) ?? byId(defaultView) ?? resolved[0] ?? null`.
- `activeViewId = activeInstance.instance.id` (≡ today's id since id === type).
- `options` channel: `renderProps.options = activeInstance.instance.options`
  (replaces `viewOptions?.[activeViewId]` — same value in ST2).
- Render: `renderIsolated(DataViewSlots.View.id, activeInstance.viewType, renderProps)`.
- Empty-state guard keys on `!activeInstance`.

No change to `viewState.*`, the filter controller, `renderProps`' other fields,
or the layout/markup.

### 5. Switcher wrapper takes instances — `web/components/view-switcher.tsx`

Change its prop from `views: SealContributions<DataViewContribution>[]` to
`instances: ResolvedViewInstance[]`, mapping each to the chrome's
`{ id, title, icon }`:

```ts
options={instances.map((r) => ({
  id: r.instance.id,
  title: r.instance.name,   // was v.title
  icon: r.viewType.icon,
}))}
```

(Keeping the wrapper — ST4 hangs add/rename/duplicate actions off it.)

### 6. Flip `id` → `type` in the 4 view children

`plugins/{list,table,gallery,tree}/web/index.ts` — each
`DataViewSlots.View({ id: "...", ... })` → `type: "..."`. Values unchanged
(`"list"`, `"table"`, `"gallery"`, `"tree"`).

### 7. Docs

- `plugins/primitives/plugins/data-view/CLAUDE.md` — hand-written prose: the
  "Adding a new view child" step (`id: "<view>"` → `type: "<view>"`), and the
  Architecture/Collection-consumer notes that say "contributes one
  `DataViewContribution`" / "select views by id" → clarify *type* id vs
  *instance* id (the public `views={[…]}` whitelist is still **type** ids).
- The autogen reference blocks (data-view + 4 children + view-switcher) and
  `docs/plugins-{compact,details}.md` regenerate via `./equin build`;
  `plugins-doc-in-sync` enforces it.

## Critical files

- `plugins/primitives/plugins/data-view/web/slots.ts` — contribution shape (`id`→`type`, `configSchema?`).
- `plugins/primitives/plugins/data-view/core/internal/types.ts` + `core/index.ts` + `web/index.ts` — `ViewInstance` type.
- `plugins/primitives/plugins/data-view/web/internal/resolve-instances.ts` — **new** default-instances resolver.
- `plugins/primitives/plugins/data-view/web/components/data-view.tsx` — route host through resolved instances.
- `plugins/primitives/plugins/data-view/web/components/view-switcher.tsx` — accept `ResolvedViewInstance[]`.
- `plugins/primitives/plugins/data-view/plugins/{list,table,gallery,tree}/web/index.ts` — `id:` → `type:`.
- `plugins/primitives/plugins/data-view/CLAUDE.md` — prose updates.

## Non-goals (later sub-tasks)

- No config descriptor / persistence (ST3), no named-instance UI or write-back
  (ST4), no `configSchema` consumer, no resolver extraction to `primitives/views/`
  (ST6). `useViewState` stays as-is; durable sort/filter still keyed by
  instance id (≡ type id) so no migration is triggered.

## Verification

1. `./equin build` (regenerates registry + docs).
2. `./equin check` — `type-check`, `plugins-doc-in-sync`, `eslint`,
   `plugins-registry-in-sync` all green. (No new manifest/check this sub-task.)
3. Behavior parity via a multi-view consumer — `sonata/library` (gallery +
   others) or `conversations/agents`:
   ```bash
   bun e2e/screenshot.mjs \
     --url http://att-1781617856-1haq.localhost:9000/<sonata-library-route> \
     --click "Table" --out /tmp/st2
   ```
   Confirm: switcher renders the same borderless ghost chrome (ST1 look); the
   active view switches; a sort toggle on a column persists across reload
   (durable state still keyed by instance id ≡ type id); the localStorage
   `active-view`/`view-state` keys are unchanged. Screenshot before/after ST2 is
   pixel-identical.
4. Single-view consumers (e.g. `deploy/servers` list, `home/app-cards`) load
   unchanged — one synthesized instance, no switcher shown.
