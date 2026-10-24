# Radio-group primitive — kill the authorable HTML `name`

## Context

The `name` attribute on `<input type="radio">` is what natively groups radios.
Two radio groups that share a `name` are, to the browser, **one** group: picking
an option in the first clears the second's native `checked` state, and arrow-key
navigation walks across both.

Two field renderers hand-roll a native radio group and hardcode a literal `name`:

| File | `name` |
| --- | --- |
| `plugins/fields/plugins/dynamic-enum/plugins/config/web/components/dynamic-enum-renderer.tsx:126` | `"dynamic-enum-field"` |
| `plugins/fields/plugins/enum/plugins/config/web/components/enum-renderer.tsx:63` | `"enum-field"` |

The two `RadioGroup` components are otherwise byte-near-identical copies.

### What is actually broken, today vs. latent

The reported case is **dynamic-enum**, and there it is still latent: each
`dynamicEnumField` descriptor found in the repo carries exactly one dynamic-enum
field, so no config page renders two at once. (The named second consumer,
`conversations/conversation-category`'s `avatarCategory`, passes
`display: "dropdown"` — it never takes the radio branch.)

The **enum** renderer, which the report did not mention, is colliding right now.
`presetsExtraFields` in `plugins/primitives/data-view/shared/sort-presets-field.ts`
puts a 2-option `direction` enum inside a nested `listField`. `ListRenderer` paints
one `FieldRenderer` per row, so a saved sort preset with three rules paints three
radio groups on one page, all named `enum-field`. Same for any config page with
two ≤3-option enums.

In both cases the controlled `checked` prop repaints the right dots, so the
visible damage today is keyboard navigation and assistive-tech grouping rather
than a wrong-looking screen. That masking is exactly why this should not be fixed
by writing a better literal.

### Intended outcome

`name` stops being a thing anyone can author. One primitive owns the radio group,
mints its own per-mount `name`, and a lint rule keeps the next renderer from
hand-rolling a third copy.

## Approach

### 1. New primitive: `primitives/css/plugins/radio-group`

Sibling of `toggle-chip` (interactive control) and `selection-indicator`
(presentational), both already under `primitives/plugins/css/plugins/`.

```
plugins/primitives/plugins/css/plugins/radio-group/
├── CLAUDE.md
├── package.json                      # copy toggle-chip's, rename
├── lint/index.ts                     # + no-adhoc-radio.ts
└── web/
    ├── index.ts                      # barrel: RadioGroup, RadioGroupProps
    └── internal/radio-group.tsx
```

`web/internal/radio-group.tsx` is the current `RadioGroup` body lifted verbatim,
with one change that is the whole point:

```tsx
export interface RadioOption {
  readonly value: string;
  readonly label: string;
}

export function RadioGroup({ options, value, onChange, className }: RadioGroupProps) {
  // The native `name` is what groups radios. Minted per mount, never authored —
  // so two RadioGroups on one page are structurally two groups, and no caller
  // can pick a literal that collides with another field's.
  const name = useId();
  …
}
```

`useId` is React's, already used across the repo (e.g.
`primitives/collapsible/web/internal/use-collapsible.ts`).

`RadioOption` is structurally satisfied by both existing option types with no
adapter — `DynamicEnumOption` (`dynamic-enum/plugins/config/web/internal/slots.ts:4`)
and `EnumOption` (`enum/plugins/config/core/internal/enum.ts:7`) are both
`{ readonly value: string; readonly label: string }`.

Keep the existing markup: `Stack role="radiogroup"`, `Stack as="label"` per row,
native `<input type="radio" className="accent-primary">`, `<Text variant="body">`.
Native inputs are UA-drawn, so `selection-indicator`'s `RadioIndicator` does not
apply — that primitive's `CLAUDE.md` explicitly scopes itself to presentational
boxes and excludes native form controls.

Dependencies are `ui-kit` (`cn`), `spacing` (`Stack`), `text` (`Text`) — all
below it, no cycle. The `no-adhoc-layout` `ignores` list already covers
`plugins/primitives/plugins/css/plugins/**`, so no allowlist edit is needed.

### 2. Both renderers consume it

Delete the local `RadioGroup` from each renderer and import the primitive. Each
file keeps its own `useRadio` policy line (`display === "radio" || (display !== "dropdown" && options.length <= 3)`)
and its own `DropdownSelect` — that radio-vs-dropdown rule is config-field policy,
not a CSS concern, and pushing it into the primitive would leak domain into a
layout plugin.

- `plugins/fields/plugins/enum/plugins/config/web/components/enum-renderer.tsx`
- `plugins/fields/plugins/dynamic-enum/plugins/config/web/components/dynamic-enum-renderer.tsx`

Both import paths are legal runtime barrels
(`@plugins/primitives/plugins/css/plugins/radio-group/web`).

### 3. Lint rule: `radio/no-adhoc-radio`

Without this, the fix is a one-time cleanup and the footgun survives. Mirror
`primitives/css/plugins/radius/lint/` (the smallest existing example):

- `lint/no-adhoc-radio.ts` — flags any JSX `<input>` whose `type` attribute is the
  literal `"radio"`. Message: route through
  `@plugins/primitives/plugins/css/plugins/radio-group/web`, which owns the
  per-mount `name`.
- `lint/index.ts` — `export default { name: "radio", rules: { "no-adhoc-radio": … }, ignores: { "no-adhoc-radio": ["plugins/primitives/plugins/css/plugins/radio-group/**"] } }`

The root `eslint.config.ts` auto-discovers `lint/index.ts` and registers the rule
repo-wide as `error`; the `eslint` built-in check then enforces it. Genuine
one-offs escape per-site with
`// eslint-disable-next-line radio/no-adhoc-radio -- <reason>`.

### 4. Docs

- `CLAUDE.md` for the new plugin — state the invariant (the `name` is minted, never
  authored) and why, plus the `selection-indicator` boundary.
- The autogen reference blocks in the touched `CLAUDE.md`s and
  `docs/plugins-*.md` are regenerated by `./equin build`; do not hand-edit.

## Non-goals

- **The duplicated `DropdownSelect` + label/description header** in the two
  renderers. `config_v2/plugins/fields/web` already exports a `FieldHeader` that
  neither renderer uses; consolidating that is a real cleanup but a separate one,
  and folding it in here would blur what this change is for.
- **Migrating `toggle-chip`'s `SegmentedControl` or `relate-mode-chip`**, which
  carry `role="radiogroup"` on button-based controls. They have no native `name`
  and no collision.

## Verification

1. `./equin build` (background — see `CLAUDE.md`), which runs
   `./equin check`, covering `eslint`, `type-check`, and
   `plugin-boundaries`.
2. Confirm the lint rule bites: temporarily add a raw `<input type="radio">` to a
   feature file and check `./equin check eslint` fails on it.
3. Reproduce the live enum case in the browser at
   `http://<worktree>.localhost:9000` → Settings → Config → any DataView `views`
   descriptor. Add two sort-preset rules, then:
   - Set rule 1 to `desc` and rule 2 to `asc`. Both must hold their own value.
   - Focus rule 1's radio and press ArrowDown/ArrowUp — the roving focus must stay
     inside rule 1's pair and never jump into rule 2's.
   - Inspect the DOM: the two groups must have different `name` values.
4. Repeat step 3 on a radio-mode enum page that is not list-nested — Settings →
   Config → `apps.sonata.notation` (`staffLayout`, `display: "radio"`).
5. Dynamic-enum regression only (no collision available to reproduce): Settings →
   Config → any `ui.tokens.*` preset field that resolves to ≤3 options still
   selects and persists.
