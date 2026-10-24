# Enforce slot-render isolation (no raw `.component` rendering)

## Context

The parent task ([`2026-06-01-global-single-match-dispatch-slot.md`](./2026-06-01-global-single-match-dispatch-slot.md))
added isolation-by-default primitives — `defineRenderSlot().Render` (render all,
each wrapped in an error-boundary item-middleware) and `defineDispatchSlot().Dispatch`
(single match, isolated). But **nothing forces consumers onto the safe path.** A
plugin can still call `slot.useContributions()` and render `<c.component .../>`
by hand, silently skipping the error-boundary middleware — the exact gap that let
one malformed tool-call event take down the **entire miller layout** instead of
one row. The safe path must *fail loudly* (compile/lint error), not depend on
docs or memory.

Two distinct bypass classes exist repo-wide:

- **Class A — render bypass.** The slot *is* a `defineRenderSlot`/`defineDispatchSlot`,
  but a consumer hand-renders `<c.component/>` off `useContributions()`. Live
  examples: `apps/.../sonata/.../sonata-layout.tsx` (bypasses `Sonata.Section.Render`),
  `apps/web/components/apps-layout.tsx:52` (`<activeApp.component/>` off the
  already-`defineRenderSlot` `Apps.App`).
- **Class B — raw-slot bypass.** ~18 slots are raw `defineSlot<{… component …}>`
  that never adopted the primitives at all (full list below).

A naive "ban `<x.component/>` JSX" lint rule is the wrong tool: it false-positives
on the *legitimate* renders inside `.Render` children callbacks (`<item.component node={n}/>`),
on data-only `useContributions()` (token presets, shortcuts, command-palette), and
on the slots that genuinely cannot self-isolate (the error boundary rendering its
own actions). We need a mechanism that distinguishes safe from unsafe *structurally*.

## Goal — the invariant

> A slot contribution's `component` is renderable **only** through `.Render` /
> `.Dispatch`. A slot that carries a `component` **must** be a
> `defineRenderSlot`/`defineDispatchSlot`. Both are enforced at build time.

## Design

Two complementary, structural enforcements (decided with the user: make
`.component` *private at the slot level* so all components are forced through the
render primitive; land everything in one change, split across subagents).

### 1. Make `component` private on render/dispatch slots (closes Class A, compile-time)

TS has no `private` for object properties, but we get the same guarantee at the
type level: a render/dispatch slot's `useContributions()` return type **omits**
`component`, so `<c.component/>` is a compile error — while every other field
(`id`, `order`, `title`, `section`, `.length` presence checks, `Apps`' `icon`/`path`)
stays fully readable. The real component is still handed to `.Render`'s `children`
callback (which runs *inside* the middleware wrapper), so prop-injecting renders
keep working. **Runtime is unchanged** — types-only, exploiting the
`as unknown as` seam the primitive already uses (`render-slot.tsx:75`, `:183`).

In `plugins/primitives/plugins/slot-render/web/internal/render-slot.tsx`:

```ts
/** Public hook view: component is private — render via .Render/.Dispatch only. */
type HideComponent<T> = Omit<T, "component">;

export interface RenderSlot<P> {
  (props: RenderRow<P>): Contribution;              // factory: real component in (ergonomic)
  id: string;
  useContributions(): HideComponent<RenderRow<P>>[]; // component hidden → not renderable
  Render: ComponentType<RenderProps<RenderRow<P>>>;  // children gets the REAL component
}

export interface DispatchSlot<Props, Key extends string = string> {
  (c: DispatchContribution<Props, Key>): Contribution;
  id: string;
  useContributions(): HideComponent<DispatchContribution<Props, Key>>[];
  Dispatch: ComponentType<Props>;
}
```

- **Do not `extends Slot<P>`** — that pins one `P` for both the factory (needs the
  real component) and the hook (must hide it). Inline the members instead. The
  existing double-cast (`slot as unknown as RenderSlot<P>`) makes this free.
- Internal `.Render`/`.Dispatch` reference the runtime `slot.useContributions()`
  (which still carries `component`), not the retyped public handle — already true
  at `render-slot.tsx:88`/`:192`, so no internal change needed.
- Keep `RenderProps.children`'s `item` param as the **real** `RenderRow<P>`
  (un-branded) — `render-slot.tsx:49-52` is already correct.

### 2. Global lint rule `slot-isolation/no-raw-component-slot` (closes Class B)

Privacy on render slots can't stop a *new* author from reaching for raw
`defineSlot<{component}>`. A global ESLint rule does, with a guiding message.

- **New rule** at `plugins/framework/plugins/tooling/plugins/lint/core/slot-isolation/no-raw-component-slot.ts`
  + barrel `…/slot-isolation/index.ts` (model: `…/icon-safety/no-lucide-react.ts`),
  exported from `…/lint/core/index.ts`.
- **Registered globally** in `eslint.config.ts` `baseConfigs` exactly like
  `icon-safety/no-lucide-react`: add to `plugins` (`"slot-isolation": { rules }`)
  and `rules` (`"slot-isolation/no-raw-component-slot": "error"`). This is what
  makes it govern **all** consumers repo-wide, not one subtree.
- **AST matcher (syntactic, no type-checker needed).** Flag a `CallExpression`
  whose callee is `defineSlot` and whose `typeArguments[0]` — inline `TSTypeLiteral`
  *or* a locally-declared `interface`/`type` it references — has a `component`
  `TSPropertySignature` typed as `ComponentType`/`FC`/`React.ComponentType`. Key on
  the member literally named `component` so legitimate `icon: ComponentType<…>`
  fields are untouched. (Verified: all Class B slots annotate with the literal
  `ComponentType`, so syntactic matching is sufficient and robust.)
- **Message:** "Slots with a `component` field must use `defineRenderSlot` /
  `defineDispatchSlot` from `@plugins/primitives/plugins/slot-render/web` for
  error-boundary isolation. If this slot renders into a foreign tree or inside the
  boundary itself, keep `defineSlot` and add
  `// eslint-disable-next-line slot-isolation/no-raw-component-slot -- <reason>`."

### 3. Small primitive extension: predicate matcher on `defineDispatchSlot`

Two slots dispatch by an arbitrary predicate, not a string/RegExp key
(`Item.Avatar`'s `match: (conv)=>boolean`). Rather than push them to an escape
hatch, generalize `DispatchContribution.match` to also accept a predicate, so the
clean path covers them:

```ts
match: Key | RegExp | ((props: Props) => boolean);  // exact > regex > predicate, in registration order
```

Matching precedence in `.Dispatch` (`render-slot.tsx:196-205`): exact string,
then RegExp, then predicate. Keeps isolation; absorbs `Item.Avatar` natively.

### 4. Isolation helper + exemptions for the genuinely-uninsolatable

Three slots cannot adopt the primitive. They stay raw `defineSlot` with a
justified allow-comment:

| Slot | File | Why exempt |
|---|---|---|
| `Core.Root` | `web-sdk/core/slots.ts:43` | Framework bootstrap; `web-sdk/core` **cannot import** slot-render (slot-render depends on web-sdk — would invert the DAG). Already hand-wrapped in `<PluginErrorBoundary>` at `web-core/web/App.tsx:14`. |
| `ErrorBoundary.Action` | `error-boundary/web/slots.ts` | Rendered *inside* the boundary's own fallback (`plugin-error-boundary.tsx:91`). Wrapping it in the same middleware is circular. |
| `ActiveData.Tag` | `active-data/web/slots.ts` | Components are spliced into a foreign markdown ReactNode tree at arbitrary positions (`linkify-active-data.tsx`), not rendered as a flat slot list. |

For slots that *can* be isolated but need bespoke selection (e.g.
`FilePane.Renderer`'s tiered `supports()` resolution), export a safe manual
helper from slot-render so they keep isolation without `.Render`:

```ts
/** Render a single contribution's component wrapped in the item middlewares
 *  (error-boundary isolation). For bespoke selection that .Render/.Dispatch
 *  can't express. Still fully isolated — NOT an escape from isolation. */
export function renderIsolated(slotId: string, contribution: Contribution, props?): ReactNode;
```

`FilePane.Renderer` keeps its `supports()`/tier logic + allow-comment, but renders
the chosen renderer via `renderIsolated` instead of bare `<C/>` — so it gains
isolation it lacks today.

### 5. Docs

`plugins/framework/plugins/web-sdk/CLAUDE.md` currently *teaches the unsafe pattern*
under "Rendering contributions" (`panels.map((p) => <p.component/>)`). Rewrite it
to teach `.Render`/`.Dispatch` and state the invariant. `./equin build`
regenerates the slot-render / migrated-plugin autogen doc blocks.

## Migration (Class B → primitives)

`useContributions()` callers reading non-component fields are unaffected.
Contributors (the `defineSlot(...)` *call sites* that pass `component`) only change
where a `match`/key field is added (dispatch targets).

| Slot | File | Target | Render site(s) | Contributor change |
|---|---|---|---|---|
| `Agents.List/ListActions/View/AgentActions/SystemAgent` | `agents/web/slots.ts` | `defineRenderSlot` | `agents-list.tsx`, `panes.tsx`, `system-folder.tsx` | none |
| `Tasks.TaskActions/ListActions` | `task-list/web/slots.ts` | `defineRenderSlot` | `task-list/plugins/tree/web/tasks-list.tsx` | none |
| `Item.Chips` | `conversation-ui/item/web/slots.ts` | `defineRenderSlot` | `conversation-item.tsx` | none |
| `Item.Avatar` | same | `defineDispatchSlot` (predicate match, §3) | `conversation-item.tsx` | `match:` already present |
| `Conversation.PromptInput` | `conversation-view/web/slots.ts` | `defineRenderSlot` (presence via `.length`) | `conversation-view.tsx` | none |
| `SegmentedProgressBar.Variant` | `ui/segmented-progress-bar/web/slots.ts` | `defineDispatchSlot` (key = active id) | `segmented-progress-bar.tsx` | add `match` (= `id`) |
| `ThemeEngine.VariantGroup` | `ui/theme-engine/web/slots.ts` | `defineRenderSlot` | `theme-customizer.tsx` (×2) | none |
| `Profiling.Section` | `debug/profiling/web/slots.ts` | `defineRenderSlot` | `gantt-view.tsx` | none |
| `Deploy.Section` | `deploy/shell/web/slots.ts` | `defineRenderSlot` | `deploy/.../panes.tsx` | none |
| `Catalog.Category` | `forge/catalog/web/slots.ts` | `defineDispatchSlot` (key = selected id; list via `useContributions`) | `catalog-view.tsx` | add `match` (= `id`) |
| `Apps.App` *(already `defineRenderSlot`, Class A)* | `apps/web/slots.ts` | `defineDispatchSlot` (key = active path) | `apps-layout.tsx:52` | add `match` (= `path`) |
| `Sonata.Section` *(already `defineRenderSlot`, Class A)* | — | fix render site only | `sonata-layout.tsx` | none |
| `Editor.Block` | `page/editor/web/slots.ts` | `defineDispatchSlot` (key = block type) | `block-row.tsx` | add `match` (= `block.type`) |
| `Fields.Renderer` | `config_v2/fields/web/internal/slots.ts` | `defineDispatchSlot` (key = field type id) | `field-renderer.tsx` | `match` from `component.type.id` |
| `FilePane.Renderer` | `file-pane/web/slots.ts` | raw + `renderIsolated` + allow-comment (tiered `supports`) | `file-content.tsx` | none |
| pane `actionsSlot` *(dynamic)* | `primitives/pane/web/pane.ts:846` | internal `defineRenderSlot`; `.Render` for visible + `renderIsolated` for ghost-measure | `pane-chrome.tsx` | none |
| tabbed-view `View` *(dynamic)* | `tabbed-view/web/internal/define-tabbed-view.tsx` | internal `defineDispatchSlot` (key = active tab) | same file; consumers `Tasks.View` | none |

**Exempt (raw + allow-comment):** `Core.Root`, `ErrorBoundary.Action`, `ActiveData.Tag`.

### Subagent split (all in one change)

1. **Foundation (first, blocking)** — slot-render privacy types, predicate matcher,
   `renderIsolated` export (`render-slot.tsx`, `index.ts`). Lint rule authored but
   left **unregistered** until migrations land.
2. **Parallel migration agents** (one per cluster, after foundation):
   - A: `agents/*`  · B: `tasks/*` + tabbed-view `View`  ·
     C: `conversations/*` (Item.Chips/Avatar, PromptInput)  ·
     D: `ui/*` (SegmentedProgressBar, ThemeEngine.VariantGroup)  ·
     E: `apps/*` (Apps.App, Catalog, Deploy, Sonata, Profiling)  ·
     F: `page` Editor.Block + `config_v2` Fields + `file-pane` + pane `actionsSlot`  ·
     G: exemptions (allow-comments) + web-sdk CLAUDE.md doc.
3. **Close-out (last)** — register `slot-isolation/no-raw-component-slot: error` in
   `eslint.config.ts`; `./equin build`; fix fallout; `./equin check`.

## Critical files

- `plugins/primitives/plugins/slot-render/web/internal/render-slot.tsx`, `…/web/index.ts`
- `plugins/framework/plugins/tooling/plugins/lint/core/slot-isolation/{index.ts,no-raw-component-slot.ts}`,
  `…/lint/core/index.ts`, `eslint.config.ts`
- `plugins/framework/plugins/web-sdk/CLAUDE.md`
- the ~14 slot-definition files + ~16 render-site files in the migration table
- exemptions: `web-sdk/core/slots.ts`, `error-boundary/web/slots.ts`, `active-data/web/slots.ts`

## Verification

1. `./equin build` — TS compile is the primary gate: privacy makes every
   surviving `<c.component/>` (off a render slot's `useContributions()`) a compile
   error, and the dispatch key types catch bad `match` strings.
2. `./equin check` — `eslint` (incl. the new rule as `error`),
   `plugin-boundaries`, `plugins-doc-in-sync` all green. Confirm the rule fires:
   temporarily add `defineSlot<{component: ComponentType}>("x")` somewhere → eslint
   errors with the guidance message; remove it.
3. Open a conversation + the affected surfaces (`http://<worktree>.localhost:9000`):
   agent list/actions, task actions, conversation sidebar avatars/chips, theme
   customizer, profiling gantt, forge catalog, app rail, page editor blocks, file
   pane diff — all render normally.
4. **Isolation regression** — make one migrated contribution throw (e.g. an
   `AgentActions` component), rebuild: only that row shows the boundary fallback;
   the surrounding layout and both miller panes stay alive. Revert. Use
   `e2e/screenshot.mjs` for before/after.
5. Confirm exemptions still work: error-boundary action buttons render, Core.Root
   mounts, active-data inline widgets render in transcripts.
