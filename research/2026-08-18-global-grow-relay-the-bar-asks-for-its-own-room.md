# The bar asks for its own room

*A grow request that travels up, replacing a `fill: true` three files away from
the `<AdaptiveBar>` it is about.*

## Context

An `<AdaptiveBar>` must be the **growing cell of a single-line row**. It puts
`min-w-0 flex-1` on its own root and reads
`barRoot.getBoundingClientRect().width` as *the room I was given*. If any box
between the bar and that row shrink-wraps to its content, the premise inverts:
every eviction shrinks the width that decides the next eviction — a one-way
ratchet whose end state is a 0px row with everything hidden.

When the bar is rendered by a **render-slot contribution**, one such box is
`slot-render`'s per-contribution cell
([`render-slot.tsx:54`](../plugins/primitives/plugins/slot-render/web/internal/render-slot.tsx)):

```tsx
fill ? "flex min-w-0 flex-1 items-center" : "flex min-w-0 items-center"
```

Rigid by default. So a bar-hosting contribution has to declare `fill: true` —
in the plugin barrel, two or three files away from the `<AdaptiveBar>` the
declaration is about, with nothing between them that states the connection.

Nothing catches the omission. The contract lives in prose
(`adaptive-bar/CLAUDE.md`) plus a runtime report — the weakest and
second-weakest rungs of the fix ladder. Both slot-hosted bars in the repo got it
wrong once each: the conversation prompt-template chips (fixed in `5b29f7d61`)
and the Sonata display picker (fixed in `a55429983`). Two for two.

**The intended outcome:** the mistake has no spelling. There is nothing to
declare, so nothing to forget.

## Why not a check

The obvious next rung is a check: the contributions facet knows every
contribution and its component, so "does this component transitively render an
`AdaptiveBar`" looks statically answerable. Two reasons it is the wrong answer
here:

1. **The machinery does not exist.** The contributions facet captures the
   component's runtime `.name` string and nothing else — no pointer to a
   declaring file. The repo has no JSX-usage index and no component-render
   graph; `aria-safety/no-orphan-composite-role` documents the same gap and
   works around it with a manual disable. Building one is a large new static
   analysis whose answer is still approximate.
2. **It covers one of the two links.** The chain is `row → … → cell → … → bar`,
   and the cell is only one box in it. `prompt-editor` had to relay the grow
   through its own dimming wrapper too, and `DisplayPicker` through a `<Fill>`.
   A check on the *contribution* cannot see either. So it would move one link of
   a two-link contract to rung 3 and leave the other at rung 5.

## The design: the request travels, the declaration disappears

The bar knows it needs room. Nobody else has to be told.

A new leaf primitive `primitives/css/grow-relay` carries a **grow request** from
the bar up through every box that has to relay it. It is modelled on the
existing [`popup-open`](../plugins/primitives/plugins/popup-open/CLAUDE.md)
precedent byte-for-byte — a counted registry in context, a render-prop scope
that both provides the context and reads the aggregate, a `useReport…`-shaped
hook, and a no-op default so the hook is safe with no scope above it.

Three pieces:

```tsx
// The leaf. Publishes "something under you needs the inline slack".
// Returns whether the whole chain above has granted it (see Acknowledgement).
function useRequestGrow(active: boolean): GrowGrant;

// An intermediate box. Grows when asked, and forwards the ask upward.
<GrowRelay>{(growing) => <div className={growing ? …}>{children}</div>}</GrowRelay>

// The row. "The request stops here — this box already has the width."
<GrowRelay.Stop>{children}</GrowRelay.Stop>
```

The render prop is the same deliberate choice `PopupOpenScope` makes: providing
the scope and reading the aggregate are **one component**, so a consumer cannot
wire half of it.

### Who plays which part

| box | part | why |
|---|---|---|
| `AdaptiveBar` (not `.Collapsed`) | requester | `.Collapsed` is one rigid `⋯`; it holds no slack and asks for none |
| `SlotItemCell` | relay | `flex-1` when `fill === true` **or** a descendant asked. Its `display:contents` branch generates no box, so it relays the request without growing |
| `Fill` | relay | it already grows, but its own parent may still need to — so it forwards rather than absorbs. This is the Sonata chain: cell → `Fill` → `Stack` → bar |
| prompt-editor's dimming wrapper | relay | today it branches on `item.fill`; that branch and the `fill` read both disappear |
| reorder's edit-mode item + content wrapper | relay | so a bar keeps working in edit mode, and so the `console.error` below stops being wrong |
| `Line` (⇒ `Row`, `Bar`) | stop | the row is where slack comes from |
| a host that owns a row but isn't a `Line` | stop | the app tab strip and prompt-editor's toolbar, both `Stack direction="row"` |

**Why `Line` and not `Stack`.** Whether a box "already has the width" is not
statically knowable — a `Line` inside a shrink-wrapping cell shrink-wraps too.
But `Line` is the exact boundary the bar's contract already names ("the growing
cell of a single-line row (`Line`/`Row`/`Bar`)"), so stopping there stops at the
contract's own edge. `Stack direction="row"` must *not* stop: in the Sonata
chain a `Stack` sits **between** the `Fill` and the bar, and stopping there
would leave the cell never told.

Forgetting a `Stop` is the cheap direction of the asymmetry, which is the point:
the request escapes one relay further and some ancestor cell grows into slack
its rigid siblings did not want — invisible. Forgetting `fill: true` broke the
bar. That is why this trades one for the other rather than adding a second
declaration.

Non-participating boxes are **transparent**: React context passes straight
through a raw `<div>`, so an un-instrumented wrapper does not break the chain's
bookkeeping — it only fails to grow itself, which is exactly what the existing
`no-slack` runtime probe exists to catch.

### Acknowledgement, and why it is needed

`AdaptiveBar` measures inside a layout effect (`useResizeObserver`'s first
callback runs synchronously there). React runs layout effects child-first, and
a `setState` from one flushes *after* all of them. So on the very first commit
the bar would measure the **un-grown** width — and the `no-slack` probe, which
latches `degraded` for good, could fire on a host that is about to be fine.

So the request is acknowledged. The context carries a `granted` flag and each
relay composes it:

```ts
const NO_RELAY = { register, unregister, granted: true, relays: 0 };  // nothing to wait for

// inside <GrowRelay>
const growing = count > 0;
const parent  = useRequestGrow(growing);
provide({ …, granted: growing && parent.granted, relays: parent.relays + 1 });
```

`granted` is therefore **true iff every relay between the bar and its row has
applied the grow** — a fixpoint that settles in one sync pass per level of
depth, all before paint. `useRequestGrow` returns `{granted: true, relays: 0}`
when there is no relay above, so a bar rendered straight into a row (the pane
header, the app tab bar) is settled immediately and costs nothing.

`reconcile` gates on it: `if (!grant.granted) return;` right beside the existing
`if (root === null) return;`, with `grant.granted` in the observer's deps so the
pass re-runs the instant it flips. No extra frame is visible — all of it happens
inside the same pre-paint layout phase.

`granted` says the *instrumented* chain is complete. It does **not** say the bar
got pixels — a raw wrapper in between still swallows the grow, and that is the
`no-slack` probe's job. The two are complementary and the fault message can now
say which: `relays: 0` means nothing above the bar claimed the request (it is
not in a slot cell — its row simply has no slack to give), while `relays: n`
means every box this primitive can see relayed and the offender is one it
cannot — a hand-rolled wrapper between the cell and the bar.

### No oscillation

`growing` is derived from a *count of mounted requesters*, never from a
measurement, so nothing the bar decides can change it. A relay's state is
monotone for the life of its occupants: register on mount, release on unmount,
same balanced-pair discipline as `useReportPopupOpen` (the registration IS the
effect's subscription, so an unmount-while-open cannot latch a scope).

## Files

**New** — `plugins/primitives/plugins/css/plugins/grow-relay/`
(`package.json`, `CLAUDE.md`, `web/index.ts`, `web/internal/grow-relay.tsx`,
`web/__tests__/…`). Imports `react` only, so it sits below `ui-kit` and every
layout primitive can consume it without a cycle.

**Wired**

- `plugins/primitives/plugins/adaptive-bar/web/internal/adaptive-bar.tsx` —
  `useRequestGrow(!collapsed)` in `AdaptiveBarShell`; gate `reconcile`; carry
  `relays` into the `no-slack` fault.
- `plugins/primitives/plugins/slot-render/web/internal/render-slot.tsx` —
  `SlotItemCell` becomes a `GrowRelay`.
- `plugins/primitives/plugins/css/plugins/fill/web/internal/fill.tsx` — forward.
- `plugins/primitives/plugins/css/plugins/line/web/internal/line.tsx` — stop.
- `plugins/reorder/plugins/editor/web/internal/items.tsx` — relay inline grow on
  the edit-mode item box and content wrapper; the `console.error` at `:118`
  stops accusing a contribution whose grow came from a relayed request. Its
  **block-axis** meaning of `fill` (`flex-col flex-1 min-h-0`, so an inner
  scroll region clamps) is untouched.
- `plugins/primitives/plugins/prompt-editor/web/components/prompt-editor.tsx` —
  the `item.fill ? <Fill> : <div>` branch collapses into one `GrowRelay`;
  `GrowRelay.Stop` on the toolbar `Stack`, which is the row that holds the slack.
- `plugins/apps-core/plugins/tab-bar/web/components/app-tab-bar.tsx` —
  `GrowRelay.Stop` on the strip `Stack`, same reason.

**Declarations deleted** — `fill: true` on
`plugins/conversations/plugins/conversation-view/plugins/prompt-templates/web/index.ts`
and `plugins/apps/plugins/sonata/plugins/library/web/index.ts`.
`plugins/conversations/plugins/conversations-view/web/index.ts` **keeps** it:
that one is the genuine block-axis reorder declaration, not a bar.

`fill?: boolean` stays on the contribution type as an explicit escape hatch and
as reorder's block-axis flag — it is no longer the thing a bar depends on.

**Docs** — `adaptive-bar/CLAUDE.md` ("The one rule for consumers"),
`slot-render/CLAUDE.md` (the `fill: true` section), the new plugin's
`CLAUDE.md`, `.claude/skills/css/SKILL.md` (primitive index).

## Verification

- `./equin test plugins/primitives/plugins/css/plugins/grow-relay` — the
  new jsdom suite: a cell with no `fill` grows once an `AdaptiveBar` is inside
  it; nested relays propagate and compose `granted`; `Line`/`Stop` terminate;
  `AdaptiveBar.Collapsed` asks for nothing; unmount releases the count.
- `./equin test plugins/primitives/plugins/adaptive-bar` — the existing
  seven suites must stay green, `no-slack` especially: its probe now runs only
  after the grant settles.
- `./equin test plugins/primitives/plugins/slot-render`.
- `./equin check` — boundaries, registry sync, plugin-doc sync, eslint,
  types.
- `./equin build`, then look at the two real bars with the declarations
  removed: the Sonata player header (`/sonata`, open a song) and the
  conversation prompt-template chip strip — narrow the pane and watch chips
  relocate into `⋯` rather than vanish. `Debug → Reports` must show no
  `adaptive-bar` rows.
- Reorder edit mode (the pen button) over both, since the edit-mode wrapper is
  now part of the chain.

## Follow-ups worth filing

- **The block axis has the same hole.** `fill: true` still means "bounded flex
  column so an inner scroll region clamps" for reorder, declared by hand and
  detected by a `console.error`. The same handshake driven by `Scroll` would
  close it; the request would need an axis.
- **`no-adhoc-layout`'s reverted tier** still holds hand-rolled wrappers that
  cannot relay. Each one drained onto `Fill`/`Line` shortens a chain.
