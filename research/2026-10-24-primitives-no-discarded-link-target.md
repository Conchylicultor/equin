# A discarded `LinkTarget` is a lint error

## Context

`openPane.to(pane, params, opts)` returns a `LinkTarget` (`{ open, href }`) as
data; it does not navigate. The Prototypes gallery's Trash button shipped as
`openTrash={() => openPane.to(prototypesTrashPane, {}, { mode: "push" })}` —
`openTrash: () => void` — and was dead: TypeScript ignores the return of a
function assigned to a `() => void` type, so the target was built and dropped.
Nothing caught it.

What already exists:

- `Activation`'s function arm is `Action = () => void | undefined`, so a
  callback returning a `LinkTarget` passed to an *activation* prop is a tsc
  error (`link-gesture/core/internal/activation.ts`). That is rung 2, but only
  for props typed `Activation`.
- `link-gesture/no-click-navigate` flags a handler whose whole job is to
  navigate, by name. It explicitly leaves the discard case to tsc.

The hole: every other `() => void` context (React's `onClick`, a component's own
`openTrash`, `forEach`, a named handler `const go = () => openPane.to(…)`), and
a bare statement `openPane.to(…);`.

## Rungs considered

1. **Inexpressible.** The value has to exist as data (DataView `rowActivation`,
   `LinkChip activation`, `afterOpen`, ~120 call sites). TypeScript has no
   must-use return, and a `() => void` target accepts any return by design, so
   no reshaping of `to` removes the spelling: any data-returning form can be
   written in a void callback. Renaming `to` changes nothing structurally.
2. **Type error.** Possible only where we own the target type (already done for
   `Activation`; could be done for ui-kit `Button.onClick`). It cannot reach
   React's DOM handlers, third-party props or every component's own callback
   props, and would churn unrelated `onClick={() => arr.push(x)}` sites.
3. **Lint (chosen), type-aware and keyed on the TYPE, not names.** Catches the
   whole class whatever produced the target (`openPane.to`, `appLink`, an
   opener hook, `useTarget()`, `ExplorerNavigator.to`) and whatever the prop is
   called — the `openTrash` bug would not have been caught by any name list.

## Design — `link-gesture/no-discarded-link` (closed, type-aware)

A *link-like* type: any union member that has callable `open` and `href`
properties (`LinkTarget`, `{ kind } & LinkTarget`, `Activation`'s object arm).
Structural so intersections and re-declared shapes count.

Reports:

- `statement` — an expression statement (not an assignment) whose value is
  link-like, incl. `void openPane.to(…)`: built, never used.
- `voidReturn` — a function literal (arrow expression body, or a `return` in a
  function body) that returns a link-like value where its contextual type's
  call signature returns exactly `void`, and the function has no return-type
  annotation of its own.
- `voidCallback` — a non-literal function value (an identifier, a member, a
  call result) whose call signatures return a link-like value, passed as a JSX
  attribute, call argument or object property where the contextual type is a
  function returning exactly `void` (`onClick={go}`).

Exactly-`void` only: a union return (`void | undefined`, `void | Promise`) is
already checked by tsc. Fix messages: spread `openPane.link(…)` / pass the
target as an `activation` / call `.open()` if it is really an imperative open.

Test with the passthrough plugin's type-aware RuleTester harness (virtual
`case.tsx`, `tsconfig.case.json`). Then run the rule over the repo and fix every
hit; update the link-gesture CLAUDE.md ("A dropped link is a type error") and
the `no-click-navigate` header comment that says the discard case is tsc's job.

## Verification

- `./equin test plugins/primitives/plugins/link-gesture` — includes the
  `openTrash` acceptance case.
- `./equin check type-check` clean (rule registered repo-wide, all hits fixed).
- `./equin build`.
