# Element-picker: name the semantic owner component, not just the leaf primitive

## Context

When a user picks a UI element with the element-picker inspector, the emitted
`<ui-context …>` tag carries `source="<file>:<line>"` — stamped at build time onto
host (lowercase) JSX elements by the Babel plugin at
`plugins/improve/plugins/element-picker/vite/index.ts`. That attribute correctly
points at **where the host element is literally written**, which is right for app
code that authors its own markup.

It is **unhelpful for components that compose shared primitives**. The motivating
case: picking the "Opus 4.8" model dropdown. That is `LaunchControl`
(`plugins/primitives/plugins/launch/web/components/launch-control.tsx`), which
returns `<ButtonGroup>` (a shared primitive) as its root and authors **no host
element of its own**. `ButtonGroup`
(`plugins/primitives/plugins/ui-kit/web/components/ui/button-group.tsx:24`) authors
the `<div>`; `Button`/base-ui author the `<button>`. So the picked element reports:

- `source="…/button-group.tsx:26"` — the leaf primitive, not `launch-control.tsx`.
- `plugin`/`contribution` — the enclosing slot wrapper (e.g. sidebar-framing), not
  `LaunchControl`.

The semantic component sits **between** the slot wrapper (too shallow) and the
primitive host element (too deep), and is invisible because it authors no host
element and is not a slot contribution. An agent must currently grep from the
picked text + primitive file to the real component. The prior provenance plan
(`research/2026-06-13-plugins-element-picker-source-provenance.md`) *assumed*
`data-source` would land on `launch-control.tsx`; it doesn't, because LaunchControl
has no host element — this plan closes that exact gap.

**Constraint:** the served frontend is a production Vite build with the automatic
JSX runtime, so React fiber `_debugOwner`/`_debugSource` are unavailable at
runtime. The solution must work without dev-mode React.

## Approach — build-time "owner stamp" that rides prop-spread

Extend the existing Babel plugin to **also** visit uppercase **component** JSX
callsites (e.g. `<ButtonGroup …/>` written inside `launch-control.tsx`) and inject:

```
data-ui-owner="<EnclosingComponentName>@<repo-relative-file>:<line>"
```

where `<EnclosingComponentName>` is the nearest enclosing component function's name
(`LaunchControl`) and `file:line` is the callsite location (in `launch-control.tsx`).

**Why it reaches the DOM.** shadcn/base-ui primitives spread their unrecognized
props onto the host element:
- `ButtonGroup` does `<div … {...props}>` (host directly).
- `Button` does `<ButtonPrimitive … {...props}>`; base-ui's `useRenderElement` →
  `renderTag(Tag, props)` does `createElement("button", { …, ...props })`, and the
  `render={<Button/>}` path (used by the dropdown's `DropdownMenuTrigger`) merges
  via `mergeProps(props, render.props)` + `cloneElement` — both **forward arbitrary
  `data-*`** onto the host. (Verified against `@base-ui/react@1.3.0` source.)

So a `data-ui-owner` injected on the `<ButtonGroup>` / `<Button>` callsite *inside
LaunchControl* flows through the primitive onto the picked host element. The host
ends up carrying **both** `data-source` (leaf, `button-group.tsx:26`) and
`data-ui-owner` (semantic, `LaunchControl@launch-control.tsx:197`).

**Why the right component wins (self-bounding).** A `data-ui-owner` stamped on
`<LaunchControl>` *in conversation-list.tsx* **dies**, because `LaunchControl`
destructures named props with no `...rest` and never spreads onto its returned
`<ButtonGroup>`. Only stamps that ride a transparent (prop-spreading) primitive
survive — so the surviving owner is exactly the composing component
(`LaunchControl`), which authors the primitive callsite. The mechanism finds the
correct altitude automatically: prop-spreading ≈ "I'm a transparent primitive, the
owner is above me."

### Prepend, not append (the one critical detail)

The existing `data-source` stamp uses `node.attributes.push(...)` (append) — correct
for a leaf host with no competing spread. The new `data-ui-owner` stamp must use
**`node.attributes.unshift(...)` (prepend)**, placing it *before* any `{...props}`
spread on the callsite. With JSX last-wins semantics, this makes an **already-
forwarded outer owner override an inner injected one** in multi-level transparent
chains — so the outermost (most-semantic) component survives.

Worked example (the actual dropdown): in `launch-control.tsx`,
`<Button …>` is stamped `Button-callsite` only if Button itself re-spreads; but the
owner forwarded from LaunchControl's own callsite-on-the-primitive wins because it
is spread last. Net: host `<button>` gets `data-ui-owner="LaunchControl@…"`. In the
common single-level case (`LaunchControl → ButtonGroup → div`) there is exactly one
owner value and prepend vs append are equivalent.

### Honest degradation (graceful — never worse than today)

- A primitive that does **not** forward props to its host breaks the chain → owner
  absent → falls back to today's `source=`.
- **Children-composition** (picked element passed as a *child*, not via a forwarding
  primitive's props) is not covered — owner flows down the prop-spread spine only.
- Multi-level transparent stacks resolve to the outermost stamped owner (prepend);
  rare, and still more precise than the leaf.

All degradations fail closed to the current `source=` behavior.

## Implementation (file-by-file)

### 1. `plugins/improve/plugins/element-picker/vite/index.ts`
- Add `const OWNER_ATTR = "data-ui-owner";` beside `SOURCE_ATTR`.
- Extend the minimal structural `VisitorPath<N>` interface with the traversal
  surface used: `getFunctionParent(): VisitorPath<FnNode> | null` and
  `parentPath?: VisitorPath<unknown>` (keep the no-`@babel/types` constraint —
  declare loose structural types, mirror the existing style).
- Add `enclosingComponentName(path)` helper: walk `path.getFunctionParent()`
  outward; resolve a capitalized name from `FunctionDeclaration.id`,
  `VariableDeclarator` binding, or `AssignmentExpression` left; **keep walking** past
  uncapitalized/anonymous functions (e.g. `.map(...)` callbacks, `useXxx` hooks) so a
  callsite inside an inner arrow still resolves to the real component. Return
  `undefined` if none → omit the name, keep `file:line`.
- In the `JSXOpeningElement` visitor, after the existing host-only branch, add a
  **second branch**: if `name.type === "JSXIdentifier"` and `/^[A-Z]/.test(name.name)`
  (uppercase component; skip `JSXMemberExpression` like `<Menu.Trigger>` and
  namespaced names — those are base-ui callsites inside wrappers and must stay
  transparent), then:
  - idempotency guard for `OWNER_ATTR` (mirror existing lines 104-112);
  - compute `rel:line` exactly as the host branch (lines 114-119);
  - `const owner = enclosingComponentName(path); const value = owner ? \`${owner}@${rel}:${loc.start.line}\` : \`${rel}:${loc.start.line}\`;`
  - **`node.attributes.unshift(t.jsxAttribute(t.jsxIdentifier(OWNER_ATTR), t.stringLiteral(value)))`** — PREPEND.
- Comment the asymmetry: host branch **appends** `data-source` (leaf, no competing
  spread); component branch **prepends** `data-ui-owner` (forwarded outer owner must win).

### 2. `plugins/improve/plugins/element-picker/web/internal/collect-meta.ts`
- Add `nearestOwner(el)` mirroring `nearestSource` (lines 48-57): walk
  `closest("[data-ui-owner]")`, reading `m.dataset.uiOwner`, with the same
  `isMarkerSpan` skip loop (defensive — the marker span won't carry it, but a marker
  may sit between the picked element and the owner-bearing host).
- In `collectMeta` (lines 88-103) add `owner: nearestOwner(el),`.

### 3. `plugins/improve/plugins/element-picker/core/internal/token.ts`
- Add `owner?: string;` to `UiContextMeta` (after `source`) with a doc comment.
- `serializeUiContext`: append `${attr("owner", m.owner)}` after `source`.
- `parseUiContext`: add `owner: get("owner"),`.
- No `UI_CONTEXT_RE` change — it already matches arbitrary `[\w-]+="…"` attributes.

### 4. `plugins/improve/plugins/element-picker/core/internal/token.test.ts`
- Extend the full round-trip case with
  `owner: "LaunchControl@plugins/primitives/plugins/launch/web/components/launch-control.tsx:197"`.
- Assert `owner` containing `@`, `:`, `/` survives serialize/parse (it's quoted).

### 5. `plugins/improve/plugins/element-picker/CLAUDE.md`
- In "Token format", add `owner` to the attribute list + example open tag, and a
  sentence: `owner` carries `Name@file:line` of the nearest **semantic** component,
  stamped by injecting `data-ui-owner` on uppercase component callsites which rides
  `{...props}` / base-ui forwarding to the host; omitted when absent; complements
  `source` (leaf primitive file).

## Reused patterns / existing code
- Babel `JSXOpeningElement` visitor, idempotency guard, repo-relative posix path,
  plugin-presence gating via the `vite/` folder discovery — all already in
  `vite/index.ts`; the new branch mirrors them.
- `nearestSource` + `isMarkerSpan` skip walk — `collect-meta.ts:40-57` (template for
  `nearestOwner`).
- `attr()` omit-when-undefined serialization + `get()` parse — `token.ts`.

## Verification
1. **Unit:** `bun test plugins/improve/plugins/element-picker/core/internal/token.test.ts`
   — `owner` round-trips.
2. **Build:** `./equin build`; `./equin check` (plugin-boundaries,
   plugins-registry-in-sync, type-check pass — no new files/dirs, so registry is
   unaffected).
3. **DOM sanity:** in the running app, inspect the LaunchControl dropdown `<button>`
   — it should carry **both** `data-source="…/button-group.tsx:NN"` **and**
   `data-ui-owner="LaunchControl@…/launch-control.tsx:NN"`.
4. **End-to-end (Playwright):** open the picker (`MdAdsClick`), click the "Opus 4.8"
   dropdown, submit, and assert the inserted `<ui-context …>` chip now contains
   `owner="LaunchControl@…/launch-control.tsx:NN"` alongside the existing
   `source="…/button-group.tsx:NN"`. Use `bun e2e/screenshot.mjs` /
   `e2e/screenshot.mjs` as the harness.
5. **Negative check:** pick an element that authors its own host markup (e.g. a plain
   `<div>` in a feature component) — `owner` is absent or equals `source`; behavior
   is unchanged from today.

## Critical files
- `plugins/improve/plugins/element-picker/vite/index.ts` (modify — second visitor branch + enclosing-name helper)
- `plugins/improve/plugins/element-picker/web/internal/collect-meta.ts` (modify — `nearestOwner`)
- `plugins/improve/plugins/element-picker/core/internal/token.ts` (modify — `owner` field)
- `plugins/improve/plugins/element-picker/core/internal/token.test.ts` (modify)
- `plugins/improve/plugins/element-picker/CLAUDE.md` (modify — token docs)
