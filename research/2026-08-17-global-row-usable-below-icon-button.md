# Row is unusable below icon-button — cut the edge that put it there

## Context

`Row` (`plugins/primitives/plugins/css/plugins/row/`) is a layout primitive, but
it sits **above** `IconButton` in the plugin DAG. The chain:

```
css/row  →  row-actions  →  icon-button  →  action-presentation
```

so anything `IconButton` itself renders is forbidden from using `Row` —
`./equin check plugin-boundaries` rejects the cycle. Moving the consumer to
another plugin closes the same loop, because the component doing the rendering
IS `IconButton`.

Today that costs exactly one component. `PanelActionRow`
(`plugins/primitives/plugins/action-presentation/web/components/panel-action-row.tsx`)
is the labelled row an action becomes inside the adaptive bar's overflow panel.
It is a row, `Row` is the primitive for it, and it is the one component in the
repo that cannot have it. It composes `Line` and hand-writes nine chrome classes
`Row` would have supplied, with a comment recording the cycle so nobody "fixes"
it back.

**The edge is an accident, not a layering fact.** `row-actions` ships two exports
with dependency floors a whole tier apart:

| Export | What it is | Dependency floor |
|---|---|---|
| `RowActions` + `rowActionsAnchor` | the cluster container — `Pin`, mask, reveal, guards, `ControlSizeProvider` | `css/{ui-kit,pin,spacing,surface}`, `popup-open` — **no buttons** |
| `RowActionButton` | `<IconButton variant="ghost" {...sameProps} />` | `icon-button` → `tooltip`, `shortcuts`, `action-presentation` |

A barrel is the unit of dependency, so importing the *container* costs you the
*button*. `Row` only ever wanted the container.

`RowActionButton` is a **pure alias**: `IconButton` already defaults
`variant="ghost"`, `IconButtonProps` is a strict superset, and all 19 call sites
across 8 files pass only `icon` / `label` / `onClick` / `disabled` (± `tooltip`)
— never `className`. No lint rule, check, test or e2e script references it by
name.

Deleting it removes the edge. `Row` drops below `icon-button` and
`PanelActionRow` becomes an ordinary `<Row>`.

### The same shape recurs, and one instance is genuinely irreducible

`action-presentation` has the identical split at the other end of the cycle:
`internal/action-form.tsx` (the seam ~90 plugins reach) needs only `latest-ref`;
`components/panel-action-row.tsx` needs six plugins. Not required for this fix —
noted, deliberately out of scope.

Distinguish these from the repo's *real* irreducible cycles, which are correctly
worked around and must stay that way: `ui-kit` cannot compose `Frame`
(`css/ui-kit/CLAUDE.md`) and cannot import `error-boundary`'s `CrashFallback`
(`overlay-boundary/CLAUDE.md`), because those primitives are **built on**
`ui-kit`. Nothing can change that. `Row → icon-button` is not that — it is a
20-line alias holding a layout primitive one tier too high.

## The fix

### Step 1 — point the 8 call sites at `IconButton`

Mechanical: import swap + tag rename, props unchanged at all 19 sites. The
cluster keeps supplying `size="xs"` via its own `ControlSizeProvider`, so
nothing changes visually.

```tsx
// before
import { RowActions, RowActionButton } from "@plugins/primitives/plugins/row-actions/web";
<RowActions>
  <RowActionButton icon={MdClose} label="Close conversation" onClick={close} />
</RowActions>

// after
import { RowActions } from "@plugins/primitives/plugins/row-actions/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
<RowActions>
  <IconButton icon={MdClose} label="Close conversation" onClick={close} />
</RowActions>
```

Files (JSX site counts in parens):

- `plugins/conversations/plugins/conversations-view/plugins/data-view/plugins/queue/web/components/queue-item-actions.tsx` (6)
- `plugins/apps/plugins/deploy/plugins/local-serve/web/components/serve-action.tsx` (5)
- `plugins/apps/plugins/deploy/plugins/deployments/web/components/deployment-item-actions.tsx` (3)
- …plus one site each in `deploy/servers`, `events/sources`, `sonata/library`,
  `studio/compositions`, `conversations-view/data-view/history`.

Most of these import `RowActions` **too** — edit the named-import list, never
delete the import line wholesale.

### Step 2 — delete the alias (this is what makes step 3 legal)

In `plugins/primitives/plugins/row-actions/web/internal/row-actions.tsx`, drop
`RowActionButton`, `RowActionButtonProps`, and the `IconButton` import — the
file's only edge to `icon-button`. Drop both from `web/index.ts`.

Prose in the same plugin that names the deleted symbol: the `rowActionsAnchor`
JSDoc example, the `RowActions` JSDoc ("Holds one or more `RowActionButton`"),
and the barrel `description` string.

### Step 3 — `PanelActionRow` becomes a `Row`

```tsx
// before — Line + nine hand-written classes + a 12-line comment about the cycle
<Line
  as="button"
  type="button"
  disabled={disabled}
  onClick={onClick}
  className={cn(
    "w-full gap-sm rounded-md p-row text-left text-body",
    "[&_svg:not([class*='size-'])]:icon-auto",
    "hover:bg-muted/50 disabled:pointer-events-none disabled:opacity-50",
  )}
>
  <Icon />
  <Fill><Text>{label}</Text></Fill>
  {shortcut ? <Kbd>{formatShortcutLabel(shortcut)}</Kbd> : null}
</Line>

// after
<Row
  icon={<Icon />}
  hover="muted"
  onClick={onClick}
  // `disabled` drives Row's element inference as much as `onClick` does: with
  // BOTH undefined Row infers a non-interactive <div>. This row must always be
  // a real <button> — nothing above it in the panel supplies activation — and
  // `onClick` is optional, so `?? false` is what pins the inference.
  disabled={disabled ?? false}
>
  <Fill><Text>{label}</Text></Fill>
  {shortcut ? <Kbd>{formatShortcutLabel(shortcut)}</Kbd> : null}
</Row>
```

`cn` and `Line` leave the imports; `panel-action-row.tsx` is the only file in
the plugin using either, so `action-presentation` swaps two edges for one
(`css/row`).

Every hand-written class is reproduced exactly — `w-full rounded-md p-row
text-left`, `gap-sm text-body` (from `size="md"`), the byte-identical
`icon-auto` svg selector, `hover:bg-muted/50` (from `hover="muted"`), and the
disabled treatment. `Row` adds `transition-colors` (wanted — this row is
currently the only one in the app that snaps), plus `group`, `group/row-actions`
and `relative`, all inert here: the children are fixed, none is absolutely
positioned, and the panel is portaled to `document.body` so there is no ancestor
row to shadow.

**`Row` stamps no `role`,** and that is the affirmative reason it is right here,
not merely tolerable. `action-presentation/CLAUDE.md` argues at length that the
panel must never be `role="menu"` — a menu's roving tabindex and typeahead would
eat the arrow keys a relocated `role="slider"` needs. A role-free primitive
cannot turn this row into a `menuitem`. Rewrite the JSDoc to say that, replacing
the "hence these four classes" paragraph.

### Step 4 — correct the prose that is now false

`action-presentation/CLAUDE.md`, `icon-button/CLAUDE.md` (line 17, "incl.
`RowActionButton`"), and a stale comment in
`plugins/apps/plugins/deploy/plugins/deployments/web/panes.tsx`.

### Step 5 — close the escape hatch the last author used (the guard)

The cycle checker **did** fire here and named the edge correctly. What failed is
that a cycle error says *"break an edge"* without saying *"and you may not pay
for it by retyping `Row`."* Retyping was free, so it happened.

Extend the existing `plugins/primitives/plugins/css/plugins/row/lint/no-adhoc-row.ts`
with a second fingerprint. `PanelActionRow` escapes it twice today: `HOST_TAGS`
is `{span, div, button, a}` so `<Line as="button">` is skipped, and `NAMED_PAD`
(`/^p-[a-z]/`) explicitly exempts `p-row`. But **`p-row` co-occurring with
`hover:bg-*` on something that is not `Row` is the `Row` shape** — flag it on any
tag, exempting `css/row/` itself.

Measured noise: **zero.** `p-row` appears as a class token in exactly four files
repo-wide — the generated utility definition, `row.tsx`, the lint rule, and
`panel-action-row.tsx`, which this plan empties.

Two alternatives were measured and **rejected**:

- **Closing the `primitives/css/**` zone in `boundary-config.ts`.** 17 real
  edges to allowlist, 7 of them `css/layout-harness`'s (a live gallery that
  grows with every new primitive, so the list churns). Decisive objection: it
  *would not have caught this bug* — the offending edge, `row-actions →
  icon-button`, is outside the css zone entirely, and `row → row-actions` is
  legitimate and would be allowlisted.
- **A "single export sets the barrel's dep floor" check.** Not computable with
  the existing facets pipeline (`facets/plugins/cross-refs` has no intra-plugin
  module graph). And it cannot discriminate: 72% of all 7,574 cross-plugin edges
  are attributable to one source file, and even narrowed to widely-depended-on
  plugins it flags 59 — with `primitives/css/row` sitting among 58 benign hits.
  One component per file, each pulling its own deps, is the normal shape of a
  healthy plugin.

## Ordering

Steps **2 before 3** is load-bearing: run step 3 first and `plugin-boundaries`
fails on the cycle. Step 5 goes last, or it fires on `panel-action-row.tsx`
while that file is still mid-rewrite. Steps 1–2 and step 3 can be separate
commits.

After step 1, `plugins-doc-in-sync` fails until docs regenerate — expected;
`./equin build` regenerates before checking.

## Verification

```bash
./equin test plugins/primitives/plugins/action-presentation   # acceptance gate
./equin test plugins/primitives/plugins/adaptive-bar          # exercises the row form
./equin check
./equin build                                                 # run_in_background
```

`action-presentation/web/__tests__/panel-action-row.test.tsx` is the real gate —
its first case renders `<PanelActionRow icon label />` with **neither** `onClick`
nor `disabled` and asserts `tagName === "BUTTON"`, so it fails loudly if the
`?? false` is omitted. Adaptive-bar's `relocation.test.tsx` asserts on
`closest("[role='dialog']")`, structure-agnostic, and should be unaffected.

Then drive the overflow panel by hand — narrow a toolbar until an `IconButton`
relocates behind the `⋯`, and confirm the row looks and behaves as before:

```bash
bun plugins/primitives/plugins/adaptive-bar/e2e/adaptive-bar-relocate.ts --headed
```

Also re-run the row-action e2e scripts, which drive by rendered label text and
`data-ui-owner` rather than component name, so they should pass untouched:

```bash
bun plugins/primitives/plugins/row-actions/e2e/click-does-not-pin.ts
bun plugins/apps/plugins/pages/plugins/page-tree/e2e/row-actions-overflow.ts
```

`./equin build` regenerates `docs/plugins-{details,compact}.md` and the
autogen blocks in ~12 plugin `CLAUDE.md`s (`row-actions` loses the `IconButton`
use and the export; `icon-button` gains ~7 `Imported by` entries;
`action-presentation` swaps `css/line` + `css/ui-kit` for `css/row`). No
`*.generated.ts` registry changes — no plugin is added or removed.

## Risks

| Risk | Assessment |
|---|---|
| Element inference yields `<div>`, losing keyboard reach | **Real**, and the only one. Pinned by `disabled={disabled ?? false}`; caught by the existing test. |
| Visual change to the 19 row-action buttons | None. `variant="ghost"` is `IconButton`'s default; `size="xs"` comes from the untouched container. |
| Async-`onClick` spinner lost | None — that is `Button`'s runtime promise detection, reached through `IconButton` either way. |
| `onClick` type breakage | None. The same assignment already compiles at today's `RowActionButton → IconButton` boundary. |

## Rejected

**Move `RowActionButton` into `row-actions/plugins/action-button/`.** Preserves
the name at the cost of a new plugin, barrel and `CLAUDE.md`, plus the *same*
8-file import edit — and the name enforces nothing (`no-raw-actions-slot` keys on
`RowActions` and the `actions`-shaped prop, never the button). It also entrenches
a live collision: `conversation-view/jsonl-viewer/plugins/row-actions` exports a
different `RowActionButton` with an incompatible prop shape, and its `CLAUDE.md`
says the domain name is deliberate. Deleting the alias halves that collision;
minting a plugin path freezes it.

**Give `Row` an `actions` slot the caller fills instead of rendering the cluster
itself.** Re-opens the nested-interactive footgun `Row`'s split path exists to
close, and pushes chrome decisions to every call site.
