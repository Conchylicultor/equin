# Row primitive: infer the element, drop `as`, make button-in-button impossible

## Context

The `Row` primitive (`plugins/primitives/plugins/css/plugins/row/web`) defaults to
`as="button"` **and** ships an `actions` slot meant to hold interactive trailing
controls (`IconButton`, `DropdownMenuTrigger`, …). A `<button>` cannot legally
contain another `<button>`/`<a>`, so a clickable Row that carries interactive
actions emits invalid `<button>`-in-`<button>` DOM. The failure is **silent**:
depending on the browser, the action click is swallowed or falls through to the
row's own `onClick`. Today it is masked two ways — consumers either remembered the
unenforced `as="div"` workaround, or leaned on the `actions` wrapper's
`stopPropagation` over invalid DOM.

Latent instances already shipped:

- `tab-strip`, `bookmarks-bar`, `preset-row`, `start-page/recents-section` — pass
  `as="button"` (or default) **plus** an interactive `IconButton` action →
  invalid DOM, "working" only by accident.
- `task-events` (origin of this task), `task-dependencies`/`dependents`,
  `release-launcher`, `build-popover-content` — use `as="div"` (+ sometimes
  `role="button"`) to dodge the nesting.

The user's framing: **remove the `as` prop entirely** and let `Row` infer its own
element. This both eliminates the footgun structurally and removes a load-bearing
piece of tribal knowledge — the consumer never picks an element, so it can never
pick a wrong one.

### Why `as` can be removed cleanly

A repo-wide audit shows `as` takes a **closed, inferable set** of exactly three
values: `as="div"` (9×), `as="button"` (5×), `as={url ? "a" : "div"}` (1×),
`as="a"` (1×). No components, no `li`/`span`/other tags. Inference rule:

| signal | element |
|---|---|
| `href != null` | `<a>` |
| else `onClick != null` or `disabled` present | `<button>` |
| else | `<div>` |

The only thing inference can't cover is a **clickable row whose _body_ holds
interactive controls** (that would re-nest). The audit confirms this never
happens: every interactive Row (`onClick`/`href`) has a presentational body
(`ConversationItem` has zero interactive nodes; release/build rows use span +
`Badge`). The two rows with interactive *body* content
(`task-dependencies`/`dependents`) have **no `onClick` on the Row** — they are
genuine non-interactive containers (`<div>`) hosting a title `<button>` in the
body and a remove `<button>` in `actions`; inference correctly keeps them `<div>`.
So the contract **"clickable Row ⇒ presentational body; interactive controls live
in `actions`"** already holds everywhere.

`ref` (the documented tree-DnD divergence) is only passed by `quick-find` and
`ug-import-dialog` for scroll-into-view — both want the **row box**, i.e. the
outermost element. So `ref` forwards to the container, unchanged in intent.

The `tree` primitive is **not affected** — `TreeRowChrome` composes `Stack` (a
div), not `Row` (it has its own named-group reveal; see its header comment).

## Design

### 1. `Row` infers its element; `actions` always render as a sibling of the primary

File: `plugins/primitives/plugins/css/plugins/row/web/internal/row.tsx`

- **Remove `as` from `RowProps` and the destructure.** Derive the rendered tag:
  `const Tag = href != null ? "a" : (onClick != null || disabled != null) ? "button" : "div"`
  (`href`/`onClick`/`disabled` come through the existing `...rest` passthrough).
  `const interactive = Tag !== "div"`.
- **No-actions path (the overwhelming majority): unchanged structure.** Render
  `<Line as={Tag} ref={ref} …>` with `{icon}{children}` exactly as today — only
  `Tag` is now inferred instead of `As`. `type`/`disabled`/`aria-current` apply
  when `interactive && Tag === "button"`. Byte-for-byte identical output for every
  current single-element row.
- **`interactive && actions` path (the fix): split so the primary element is a
  _sibling_ of `actions`, never its ancestor.** Render the **container** as a
  non-interactive `<Line as="div" relative>` carrying the row chrome (rounded,
  hover bg, `p-row`, border, indent, single-line) + the hover-reveal pointer/focus
  handlers + `ref`. Inside it:
  - the **primary** `<Tag>` (button or `a`) wrapping the presentational
    `{icon}{children}` and receiving the interactive passthrough
    (`onClick`/`href`/`target`/`rel`/`download`/`disabled`/`type`/`title`/`aria-*`,
    incl. `aria-current`/`aria-expanded`/`aria-controls`). It contains a
    full-bleed hit-area child — `<span aria-hidden className="absolute inset-0" />`
    — that stretches over the *relative container* so the **whole padded row
    (incl. icon/children area) stays clickable**, and gives the button a natural
    accessible name from its children.
  - the **`actions`** `<span className="relative …" onClick={stopPropagation}>`
    sibling. `relative` (no z-index token needed) places it in the same positioned
    paint layer as the hit-area but later in DOM order, so it paints **above** the
    hit-area and stays clickable. (Verified against CSS stacking: positioned
    siblings paint in tree order; the `aria-hidden` hit-area is a descendant of the
    earlier `<Tag>`, the actions span is the later sibling.)
- **`div + actions` path** (non-interactive container, e.g. `task-dependencies`):
  keep the simple single-element path — `<Line as="div">` with `{icon}{children}`
  + the existing `actions` span. No split needed; a `div` nests buttons legally.

`row.tsx` is inside the layout-lint **permanent ignore glob**
(`plugins/primitives/plugins/css/plugins/**`), so the internal
`absolute`/`inset-0`/`relative` mechanics are sanctioned (same status the file
already relies on).

### 2. `SectionHeaderRow`

File: `…/row/web/internal/section-header-row.tsx` — drop `as="button"`; it always
supplies an `onClick` (toggle from props or `Collapsible` context) so it infers a
`<button>`, and its `actions` (swatches/stats) now ride the safe sibling split for
free.

### 3. Regression guard (jsdom test)

The structural split + inference make the bad DOM **unrepresentable**, so the
guard's job is to pin the invariant (it also covers the prop-composition case a
static lint rule can't see). Add
`plugins/primitives/plugins/css/plugins/row/web/__tests__/row.test.tsx` (jsdom,
auto-discovered by the repo vitest project) asserting:

1. `<Row onClick actions={<button data-testid="act"/>}>` renders the action button
   **not** nested inside any `<button>`/`<a>` (`closest("button")` from the action
   is the action itself), and the row primary is a real `<button>`.
2. Clicking the action fires the action handler and **not** the row `onClick`.
3. Inference: `href` → `<a>`; bare `onClick` → `<button>`; neither → `<div>`.
4. No-actions interactive row is a single `<button>` (no wrapper regression).

(Optional, not required for this task: a generic `no-nested-interactive` ESLint
rule under `framework/.../lint/plugins/button-safety` catching *literal* JSX
nesting repo-wide. Deferred — the structural fix is the real guard and there is no
`as` left to misuse.)

### 4. Audit — remove every `as=` from consumers (16 sites)

Removing the prop means any stray `as=` would spread onto the DOM node, so all
must go. Two buckets:

**Latent nesting bugs — drop `as` (+ now-redundant `role="button"`/`cursor-pointer`),
inference → `<button>`, split fixes the DOM:**

- `plugins/apps/plugins/browser/plugins/tabs/web/components/tab-strip.tsx` (`as="button"`)
- `plugins/apps/plugins/browser/plugins/bookmarks/web/components/bookmarks-bar.tsx` (`as="button"`, keep `className="w-auto"`)
- `plugins/apps/plugins/browser/plugins/start-page/web/components/recents-section.tsx` (`as="button"`)
- `plugins/primitives/plugins/data-view/web/components/sort/presets/preset-row.tsx` (`as="button"`, `disabled` keeps it a button)
- `plugins/apps/plugins/studio/plugins/release/web/components/release-launcher.tsx` (`as="div" role="button" cursor-pointer` → drop all three)
- `plugins/build/web/components/build-popover-content.tsx` (`as="div" role={…} cursor-pointer` → drop; conditional `onClick` still infers button when present, div when not — preserves the read-only variant)

**`as="div"` workarounds on clickable rows — drop `as`, inference → `<button>`:**

- `plugins/tasks/plugins/task-events/web/components/task-events.tsx` (conv row `as="div"` → drop; and the push row `as={url ? "a" : "div"}` → drop, `href` infers `a`/`div`)

**Genuine containers / links — drop `as`, inference keeps the same element (verify no visual change):**

- `plugins/tasks/plugins/task-dependencies/web/components/task-dependencies.tsx` (`as="div"`, no row `onClick` → stays `div`)
- `plugins/tasks/plugins/task-dependencies/web/components/task-dependents.tsx` (same)
- `plugins/plugin-meta/plugins/facets/plugins/exports/plugins/render-detail/web/components/exports-detail-section.tsx` (`as="div"`, no `onClick` → `div`)
- `plugins/ui/plugins/tokens/plugins/shadow/web/components/shadow-section.tsx` (two `as="div" hover="muted"` form rows, no `onClick` → `div`)
- `plugins/ui/plugins/theme-engine/plugins/theme-customizer/web/components/token-row.tsx` (`as="div" hover="muted"`, no `onClick` → `div`)
- `plugins/tasks/plugins/task-attachments/web/components/task-attachments.tsx` (`as="a"` + `href` → `a`)
- `…/row/web/internal/section-header-row.tsx` (`as="button"` → inferred button)

> Implementer: re-grep `as=` in every file importing `css/row` after the edits to
> confirm zero remain (`rg -n 'as=' <file>` per consumer), since a leftover would
> now leak to the DOM.

## Critical files

- `plugins/primitives/plugins/css/plugins/row/web/internal/row.tsx` — inference + split (core change)
- `plugins/primitives/plugins/css/plugins/row/web/internal/section-header-row.tsx` — drop `as`
- `plugins/primitives/plugins/css/plugins/row/web/__tests__/row.test.tsx` — new regression test
- 14 consumer files above — remove `as=` (+ redundant `role`/`cursor-pointer`)
- `plugins/primitives/plugins/css/plugins/row/CLAUDE.md` — document element inference + the body-presentational/actions-interactive contract (replaces the `as` prose)

## Verification

1. **Build:** `./equin build` (regenerates docs/registry, type-checks, runs
   `./equin check`). Confirm `type-check`, `no-adhoc-layout`,
   `plugins-doc-in-sync` pass.
2. **Unit/DOM:** `bun run test:dom plugins/primitives/plugins/css/plugins/row` —
   the new regression test passes (no nested interactive; action click isolated;
   inference correct).
3. **Manual (scripted Playwright), the originating + latent cases:**
   - `e2e/screenshot.mjs` against a task with attempts/conversations — click the
     **"Open as page"** action on a `task-events` conversation row and assert a new
     root pane opens (action handler fired) **without** toggling the row's own
     pane (row `onClick` not fired).
   - Browser app: open multiple tabs, click a tab's **close** action → tab closes,
     does not merely select it; same for a **bookmark remove** and a **recents**
     row action.
   - data-view list (e.g. Tasks recent list) — a row's hover action fires its own
     handler, row body click still activates the row.
4. **DOM sanity:** in devtools, inspect a `task-events` conversation row — the
   primary is a `<button>`, the action `<button>` is a **sibling** (no
   `<button>` inside `<button>`); whole-row click still works via the hit-area.

## Out of scope

- The optional generic `no-nested-interactive` lint rule (deferred; structural fix
  + test is the guard).
- `tree`/`TreeRowChrome` (composes `Stack`, not `Row` — unaffected).
