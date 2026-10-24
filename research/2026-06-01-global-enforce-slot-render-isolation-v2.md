# Enforce slot-render isolation — v2 (base-level seal + isolated escape hatch)

> Supersedes [`2026-06-01-global-enforce-slot-render-isolation.md`](./2026-06-01-global-enforce-slot-render-isolation.md).
> Merges the stronger base-level-seal foundation from a sibling design
> ([`…-9nw8/research/2026-06-01-global-slot-render-enforcement-v2.md`]) with the
> hardened escape-hatch + correctness fixes from v1.

## Context

The parent task added isolation-by-default primitives — `defineRenderSlot().Render`
and `defineDispatchSlot().Dispatch` — each wrapping rendered contributions in the
`SlotItemMiddleware` chain (error boundary, reorder). But **nothing forces
consumers onto them.** Any code that calls `slot.useContributions()` and renders
`<c.component .../>` directly skips the error boundary — the gap that let one
malformed tool-call event take down the **entire miller layout** instead of one
row. ~26 sites do this today, and new consumers can re-introduce it freely.

The fix must be **structural** (a compile error), not docs/lint-heuristics:

- A naive "ban `<x.component/>` JSX" lint rule false-positives on the *legitimate*
  renders inside `.Render` children callbacks, on data-only `useContributions()`,
  and on slots that genuinely can't self-isolate.
- A lint rule that forbids raw `defineSlot<{component}>` needs fragile cross-file
  AST type resolution and fights legitimate deferred-render slots.

## Decision (with user)

1. **Seal `.component` at the `Slot<P>` base level**, so *every* slot — including
   raw `defineSlot` — returns an opaque, non-renderable `component` from
   `useContributions()`. `<c.component/>` is a compile error **everywhere**, with
   **no ESLint rule** required. The render primitives unseal internally.
2. **Escape hatch is isolated by default** (`renderIsolated`, keeps the middleware
   chain). A separate, greppable `UNSAFE_unsealSlotComponent` (returns a raw,
   un-isolated component) is reserved for the **3 framework cases that genuinely
   cannot self-isolate**.
3. **Land in one change**, split across subagents.

## Design

### 1. Seal type in `web-sdk/core` (new `sealed-component.ts`)

```ts
declare const SEALED: unique symbol;

/** Opaque, non-renderable component handle returned by useContributions(). */
export type SealedComponent<P = unknown> = { readonly [SEALED]: true; readonly __props?: P };

/** Maps a contribution's `component: ComponentType<X>` field → SealedComponent<X>;
 *  every other field is untouched (so `id`, `order`, `match`, `icon`, … stay readable). */
export type SealContributions<P> = {
  [K in keyof P]: K extends "component"
    ? P[K] extends ComponentType<infer Props> ? SealedComponent<Props> : P[K]
    : P[K];
};

/** UNSAFE: returns a raw, NON-isolated component. Only for slots that structurally
 *  cannot route through the middleware chain (see §4). Greppable by the UNSAFE_ name. */
export function UNSAFE_unsealSlotComponent<P>(s: SealedComponent<P>): ComponentType<P> {
  return s as unknown as ComponentType<P>;
}
```

- Key on the field literally named `component`, so legitimate `icon: ComponentType<…>`
  (e.g. `Catalog.Category`, `Apps.App`) is never sealed.
- Runtime is **unchanged** — the seal is a type-level mapped type; at runtime
  `.component` is still a `ComponentType`.

### 2. Seal `Slot<P>` (`web-sdk/core/slots.ts`)

```ts
export interface Slot<P> {
  (props: P): Contribution;                       // factory: contributors pass real ComponentType (unchanged)
  id: string;
  useContributions(): SealContributions<P>[];     // ← sealed return type
}
```

`RenderSlot`/`DispatchSlot` inherit the sealed `useContributions` automatically
(they're produced via the existing `slot as unknown as …` cast). Export
`SealedComponent`, `SealContributions`, `UNSAFE_unsealSlotComponent` from
`web-sdk/core/index.ts`.

### 3. Render primitives unseal internally (`slot-render/web/internal/render-slot.tsx`)

- **`.Render` children callback** stays typed as the **unsealed** `P` (it runs
  *inside* the middleware — the safe path). Cast the sealed item back before
  invoking: `children(clean as unknown as RenderRow<P>)` (today's `render-slot.tsx:102`).
- **`.Render` auto-render path** (no children) unseals before rendering:
  `UNSAFE_unsealSlotComponent(clean.component)` (today's `:104-108`) — still wrapped
  by `applyItemMiddlewares`, so isolated.
- **`.Dispatch`** unseals the matched component before `createElement`
  (today's `:206`/`:217`) — still wrapped by `applyItemMiddlewares`.
- **Predicate matcher** (fixes `Item.Avatar`, see migration): widen
  `DispatchContribution.match` to `Key | RegExp | ((props: Props) => boolean)`;
  precedence in `.Dispatch`: exact string → RegExp → predicate (registration order).
- **Export the safe manual helper** from `slot-render/web/index.ts`:

```ts
/** Render one contribution's component wrapped in the item middlewares
 *  (error-boundary isolation). For bespoke selection that .Render/.Dispatch
 *  can't express. STILL ISOLATED — not an escape from isolation. */
export function renderIsolated(slotId: string, contribution: Contribution, props?: object): ReactNode;
// impl: applyItemMiddlewares(createElement(UNSAFE_unsealSlotComponent(contribution.component), props), slotId, contribution)
```

### 4. Escape-hatch policy

| Mechanism | Isolated? | Use for |
|---|---|---|
| `.Render` / `.Dispatch` | ✅ | the default — render-all / single-match |
| `renderIsolated()` (slot-render) | ✅ | bespoke selection that the primitives can't express (`FilePane.Renderer`'s tiered `supports()`) |
| `UNSAFE_unsealSlotComponent()` (web-sdk/core) | ❌ | only the 3 framework cases below; each call carries a `// UNSAFE: <reason>` comment |

**The 3 `UNSAFE_` sites (genuinely cannot self-isolate):**

1. `web-core/web/App.tsx` — `Core.Root`. `web-sdk/core` can't import slot-render
   (would invert the DAG); already hand-wrapped in `<PluginErrorBoundary slot="core.root">`.
2. `error-boundary/web/components/plugin-error-boundary.tsx` — `ErrorBoundary.Action`
   renders *inside* the boundary's own fallback; wrapping it again is circular.
3. `active-data/web/internal/{linkify-active-data.tsx, use-code-replace.ts, segment-active-data.ts}`
   — `ActiveData.Tag` components are spliced into a foreign markdown ReactNode tree,
   not rendered as a flat slot list. (Prefer `renderIsolated` per splice if it fits
   cleanly; otherwise `UNSAFE_`.)

### 5. Docs

Rewrite the "Rendering contributions" section of
`plugins/framework/plugins/web-sdk/CLAUDE.md` — it currently *teaches the unsafe
pattern* (`panels.map((p) => <p.component/>)`). Replace with `.Render`/`.Dispatch`
and state the invariant: **a contribution's `component` is renderable only through
the render primitives; everything else is `UNSAFE_`.** `./equin build`
regenerates autogen doc blocks.

### Optional backstop (not load-bearing)

A tiny global ESLint rule could flag `UNSAFE_unsealSlotComponent` calls lacking an
adjacent justification comment — but the `UNSAFE_` name + greppability already make
new bypasses loud. Defer unless the user wants it.

## Migration (every direct `.component` render becomes a compile error)

Contributors (the `defineSlot(...)` call sites passing `component`) only change
where a dispatch `match`/key is introduced. `useContributions()` callers reading
non-`component` fields are unaffected.

| Slot | Slot file | Target | Render site(s) | Contributor Δ |
|---|---|---|---|---|
| `Agents.List/ListActions/View/AgentActions/SystemAgent` | `agents/web/slots.ts` | `defineRenderSlot` | `agents-list.tsx`, `panes.tsx`, `system-folder.tsx` | none |
| `Tasks.TaskActions/ListActions` | `task-list/web/slots.ts` | `defineRenderSlot` | `task-list/plugins/tree/web/tasks-list.tsx` | none |
| `Item.Chips` | `conversation-ui/item/web/slots.ts` | `defineRenderSlot` | `conversation-item.tsx` | none |
| `Item.Avatar` | same | `defineDispatchSlot` (**predicate matcher**, §3) | `conversation-item.tsx` | `match` already a predicate |
| `Conversation.PromptInput` | `conversation-view/web/slots.ts` | `defineRenderSlot` (presence via `.length`) | `conversation-view.tsx` | none |
| `SegmentedProgressBar.Variant` | `ui/segmented-progress-bar/web/slots.ts` | `defineDispatchSlot` (key = active id) | `segmented-progress-bar.tsx` | add `match` (=`id`) |
| `ThemeEngine.VariantGroup` | `ui/theme-engine/web/slots.ts` | `defineRenderSlot` | `theme-customizer.tsx` (×2) | none |
| `Profiling.Section` | `debug/profiling/web/slots.ts` | `defineRenderSlot` | `gantt-view.tsx` | none |
| `Deploy.Section` | `deploy/shell/web/slots.ts` | `defineRenderSlot` | `deploy/.../panes.tsx` | none |
| `Catalog.Category` | `forge/catalog/web/slots.ts` | `defineDispatchSlot` (key = selected id; list via `useContributions`) | `catalog-view.tsx` | add `match` (=`id`) |
| `Apps.App` *(already RenderSlot; Class A)* | `apps/web/slots.ts` | `defineDispatchSlot` (key = active path) | `apps-layout.tsx:52` | add `match` (=`path`) |
| `Sonata.Section` *(already RenderSlot; Class A)* | — | fix render site → `.Render` | `sonata-layout.tsx` | none |
| `Editor.Block` | `page/editor/web/slots.ts` | `defineDispatchSlot` (key = `block.type`) | `block-row.tsx` | add `match` |
| `Fields.Renderer` | `config_v2/fields/web/internal/slots.ts` | `defineDispatchSlot` (key = field type id) | `field-renderer.tsx` | `match` from `component.type.id` |
| `FilePane.Renderer` | `file-pane/web/slots.ts` | keep slot + **`renderIsolated`** (tiered `supports()`) | `file-content.tsx` | none |
| pane `actionsSlot` *(dynamic)* | `primitives/pane/web/pane.ts:846` | internal `defineRenderSlot`; `.Render` (visible) + `renderIsolated` (ghost-measure) | `pane-chrome.tsx` | none |
| tabbed-view `View` *(dynamic)* | `tabbed-view/web/internal/define-tabbed-view.tsx` | internal `defineDispatchSlot` (key = active tab) | same file (consumers `Tasks.View` etc.) | none |

**`UNSAFE_unseal` (no migration):** `Core.Root`, `ErrorBoundary.Action`, `ActiveData.Tag`.

**Unaffected (already inside `.Render` children — typed unsealed):** `action-bar.tsx`,
`header-view.tsx`, `event-row.tsx`, `app-shell-layout.tsx`, `prompt-editor.tsx`,
`text-editor.tsx`, `plugin-tree.tsx`, `stats-panel.tsx`, `conversation-view.tsx`
(PromptBar), `plugin-change-card.tsx`, `define-detail-sections.tsx`, `jsonl-pane.tsx`.

### Subagent split (one change)

1. **Foundation (first, blocking):** `sealed-component.ts`; seal `Slot<P>`; barrel
   exports; render-primitive unseal (`.Render`/`.Dispatch`); predicate matcher;
   `renderIsolated` export. *(After this, `./equin build` surfaces every
   migration site as a compile error — the worklist.)*
2. **Framework `UNSAFE_` sites:** `App.tsx`, `plugin-error-boundary.tsx`, `active-data/*`.
3. **Parallel migration agents** (per cluster): A `agents/*` · B `tasks/*` +
   tabbed-view `View` · C `conversations/*` (Item.Chips/Avatar, PromptInput) ·
   D `ui/*` · E `apps/*` (Apps.App, Catalog, Deploy, Sonata, Profiling) ·
   F `page` Editor.Block + `config_v2` Fields + `file-pane` + pane `actionsSlot` ·
   G web-sdk `CLAUDE.md` doc.
4. **Close-out:** `./equin build`; fix fallout; `./equin check`.

## Critical files

- `plugins/framework/plugins/web-sdk/core/{sealed-component.ts (new), slots.ts, index.ts}`
- `plugins/primitives/plugins/slot-render/web/{internal/render-slot.tsx, index.ts}`
- `plugins/framework/plugins/web-sdk/CLAUDE.md`
- `UNSAFE_` sites: `web-core/web/App.tsx`, `error-boundary/web/components/plugin-error-boundary.tsx`, `active-data/web/internal/*`
- the ~14 slot-definition + ~16 render-site files in the migration table

## Verification

1. `./equin build` — primary gate. The seal makes every direct
   `<c.component/>` off `useContributions()` a compile error; dispatch key types
   catch bad `match` strings. Build must be green.
2. **Seal proof** — in a scratch file, `MySlot.useContributions()[0].component`
   used as JSX must fail to typecheck (revert after).
3. `./equin check` — `eslint`, `plugin-boundaries`, `plugins-doc-in-sync` green.
4. Open `http://<worktree>.localhost:9000` — agent list/actions, task actions,
   conversation avatars/chips, theme customizer, profiling gantt, forge catalog,
   app rail, page editor blocks, file pane all render normally.
5. **Isolation regression** — make one migrated contribution throw (e.g. an
   `AgentActions` component); rebuild: only that row shows the boundary fallback;
   surrounding layout and both miller panes stay alive. Revert; capture
   before/after with `e2e/screenshot.mjs`.
6. **`Item.Avatar` correctness** — confirm only the *first* matching avatar
   renders (predicate dispatch), not all of them.
7. Exemptions still work: error-boundary action buttons render, `Core.Root`
   bootstraps, active-data inline widgets render in transcripts.
