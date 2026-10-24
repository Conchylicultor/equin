# The passthrough anchor contract

_2026-08-20 — primitives/passthrough_

## Context

`Row` declared `[key: string]: unknown` — "spread this onto the rendered
element" — while rendering ONE element normally and TWO once given `actions`. A
caller's `data-*` selector target therefore moved from the row box to an inner
button the day someone added an action, at a call site nobody edited, with no
throw, no lint and no type error. That has been fixed in `Row` three times
(refs → `focusRef`, focus styling → owned, passthrough → routed by
destination), each time after the bug was found in the wild.

Ten more component props types carry the same open passthrough:

| component | file | today |
| --- | --- | --- |
| `Line` | `primitives/css/line/web/internal/line.tsx` | 1 host element, has `ref` |
| `Surface` | `primitives/css/surface/web/internal/surface.tsx` | 1 host element, has `ref` |
| `Card` | `primitives/css/card/web/internal/card.tsx` | relays to `Surface`, has `ref` |
| `Badge` | `primitives/css/badge/web/internal/badge.tsx` | **already 2 host elements**, no `ref` |
| `ToggleChip` | `primitives/css/toggle-chip/web/internal/toggle-chip.tsx` | relays to `Badge`, no `ref` |
| `SectionHeaderRow` | `primitives/css/row/web/internal/section-header-row.tsx` | relays to `Row`, no `ref` |
| `Row` | `primitives/css/row/web/internal/row.tsx` | 1 or 3 host elements, routes by hand |
| `OverlayPanel` | `primitives/css/ui-kit/web/components/overlay-panel.tsx` | **already 2 host elements**, has `ref` |
| `ViewportOverlay` | `primitives/css/viewport-overlay/web/internal/viewport-overlay.tsx` | 1 host element, **no `ref`, and its own `ref=` is written AFTER `{...rest}`** |
| `SurfaceOverlay` | `primitives/surface-overlay/web/internal/surface-overlay.tsx` | 1 host element, no `ref` |
| `TabProps` | `ui/tab-bar/core/types.ts` (3 variant implementations) | relays to `Line`, no `ref` |

The premise "they are single-element today" turns out to be false for two of
them, and `ViewportOverlay` already has a live instance of the defect: it writes
`ref={rootRef}` after `{...rest}`, so a caller's `ref` is silently discarded.

## The invariant

Counting host elements is the wrong measure. `Badge` renders two and is
correct; `Row` rendered one and was wrong. What actually matters is:

> **An open passthrough is a promise about ONE node. `ref` names that node; the
> bag addresses it. They must be the same node.**

That reframing is what makes the growth case harmless *and* catchable. Wrapping
`<Surface ref={ref} {...rest}>` in a new outer `<div>` keeps the promise — the
caller's attribute and the caller's ref stay together. Moving `ref` to the new
outer `<div>` and leaving `{...rest}` on the inner one breaks it, and that is
exactly the shape the guard rejects.

## Design

A new leaf plugin, `plugins/primitives/plugins/passthrough/`, owns the contract
in three layers.

### 1. The type — `Passthrough<E>` (core)

```ts
// plugins/primitives/plugins/passthrough/core/internal/passthrough.ts
export interface Passthrough<E extends HTMLElement = HTMLElement> {
  /**
   * The node the passthrough lands on — the primitive's ONE exposed element.
   * Declared HERE, on the passthrough itself, because they are one promise:
   * `ref` NAMES the node, the bag ADDRESSES it. A primitive that hands out a
   * bag and no node has stated no destination at all.
   */
  ref?: React.Ref<E>;
  [key: string]: unknown;
}
```

Pairing `ref` with the index signature is the rung-1 half of the fix: a props
type can no longer be open without also exposing the node, so "which node?" is
never unanswerable. It also removes work — React 19 treats `ref` as an ordinary
prop, so a primitive that does not destructure it (`Badge`, `ToggleChip`,
`SurfaceOverlay`, the tab variants) gets correct ref forwarding for free from
the single `{...rest}` it already writes. What is being added there is the
*type*, not the plumbing; the ref was already flowing, untyped.

The generic parameter exists for `OverlayPanel`, whose `ref` is
`Ref<HTMLDivElement>` (a mutable ref is invariant, so a bare
`extends Passthrough` would be a type error there): `extends Passthrough<HTMLDivElement>`.

### 2. The router — `splitPassthrough` (core)

The generic form of `Row`'s hand-rolled `Object.entries(rest)` loop, and the
one sanctioned way a bag may legitimately reach a second destination:

```ts
export function splitPassthrough(
  rest: Record<string, unknown>,
  isRouted: (key: string) => boolean,
): { anchored: Record<string, unknown>; routed: Record<string, unknown> };
```

`Row` keeps its own `CONTROL_KEYS` / `isControlKey` predicate (its domain
vocabulary) and passes it in:

```ts
const { anchored: boxProps, routed: controlProps } = splitPassthrough(rest, isControlKey);
```

The split existing as a *named* call is what lets the lint rule tell a
deliberate second destination apart from an accidental one.

### 3. The guard — two lint rules (`lint/`)

**`passthrough/no-anonymous-passthrough`** (syntactic). An index signature
`[key: string]: unknown` written inline in a declaration whose name ends in
`Props` is an error: spell it `extends Passthrough`. This is the gate — without
it a new primitive could open a passthrough and never be seen by the second
rule. Keying on `*Props` leaves the nine unrelated server-side event/table
payload types (`ConversationTurnCompletedPayload`, `RefAdvancedPayload`,
`ServerContribution`, …) untouched, and exempts the `Passthrough` marker itself
by construction.

**`passthrough/no-unanchored-passthrough`** (type-aware, mirroring
`button-safety/no-async-raw-button`'s use of `ESLintUtils.getParserServices`).
Triggers on any function component whose props parameter type has a **string
index signature** — resolved through the checker, so it fires across files
(`TabProps` lives in `core/`, its three implementations elsewhere) and needs no
name matching. For such a component, the rest binding is constrained to:

| messageId | rejects |
| --- | --- |
| `restEscaped` | the rest binding referenced anywhere other than a JSX spread or `splitPassthrough(rest, …)` — closes `Object.entries(rest)`, `{...rest}` into a local, handing `rest` to a helper |
| `restFannedOut` | the same bag spread onto more than one JSX element |
| `restOffRef` | the bag spread onto an element carrying no `ref` attribute, while the component destructures `ref` |
| `anchoredOffRef` | `splitPassthrough`'s `anchored` result spread onto an element with no `ref` attribute, or spread more than once |

`routed` is deliberately unconstrained — naming it *is* the statement that it
goes somewhere else.

Accepted false negative, stated in the rule's docblock: a bag spread onto a
component that renders no DOM node swallows it silently and no syntactic rule
can see that. `trigger-render-safety/no-provider-trigger-render` already covers
the closest instance of that class.

### Why lint and not a check or a runtime assert

The verdict is derivable from one file's AST plus its type info, which the
repo's own rule of thumb assigns to a lint rule rather than a `check`. And it
has to be authoring-time: a runtime assert can only compare the root element's
props against the bag *when a caller actually passes something*, so it would
stay silent on exactly the primitives nobody spreads onto today — the ones this
is meant to protect.

## Work

1. **New plugin** `plugins/primitives/plugins/passthrough/` — `package.json`,
   `CLAUDE.md`, `core/index.ts` (+ `core/internal/{passthrough,split}.ts`),
   `lint/index.ts` (+ the two rule modules and their `RuleTester` tests, in the
   `bun:test` top-level-`ruleTester.run` style of
   `row/lint/no-row-focus-class.test.ts`).
2. **Migrate the eleven props types** to `extends Passthrough` /
   `extends Passthrough<HTMLDivElement>`, dropping the now-duplicated
   `ref?: React.Ref<HTMLElement>` declarations except where the local doc
   comment carries meaning the shared one does not (`Row`, `Line`).
3. **`Row`** — replace the `Object.entries(rest)` routing loop with
   `splitPassthrough(rest, isControlKey)`.
4. **`ViewportOverlay`** — real bug: compose the caller's `ref` with the
   internal `rootRef` instead of writing `ref={rootRef}` after `{...rest}`,
   which silently drops it. Same `useCallback` shape `OverlayPanel` already
   uses.
5. **Docs** — the contract in the new plugin's `CLAUDE.md`; `Row`'s
   "The passthrough goes where `ref` goes" section shortened to cite it as the
   general rule it now is; a one-line pointer in `Line`/`Card`/`Badge`/
   `Surface`/`ToggleChip` CLAUDE.md files (`Badge`'s and `ToggleChip`'s gain a
   `ref` they did not document before).

## Verification

- `./equin check passthrough:no-anonymous-passthrough` is not a thing —
  the rules run inside `type-check`; `./equin check type-check` is the
  gate, and `./equin check` runs everything including
  `plugins-registry-in-sync`, `plugins-doc-in-sync`, `plugins-have-claudemd`.
- `./equin test plugins/primitives/plugins/passthrough` — RuleTester
  cases, including the literal historical bug (`ref` on an outer wrapper,
  `{...rest}` on the inner element) as an `invalid` case, and `Row`'s
  `splitPassthrough` shape as a `valid` one.
- `./equin test plugins/primitives/plugins/css/plugins/row` — the
  existing `row.test.tsx` must still pass after the `splitPassthrough`
  migration; it already pins the routing behaviour.
- A new jsdom test that `<Badge ref={r}>` and `<ToggleChip ref={r}>` land the
  node (they never forwarded a typed ref before).
- `./equin build`, then eyeball a chip-heavy surface
  (`http://<worktree>.localhost:9000/settings` appearance pane) for unchanged
  rendering.

## Follow-ups worth filing

- The residual false negative above (a bag spread onto a DOM-less component)
  could be closed by a dev-only assert in `Passthrough`-typed primitives, or by
  widening `trigger-render-safety`. Not in this change.
- `ui/tab-bar`'s three variants each re-implement the same relay; they are the
  natural first consumers of a shared tab shell, unrelated to this contract.
