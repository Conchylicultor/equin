# Lint rule: ban element-type chosen from post-mount state

## Context

React reconciles by **element type** at a given position. If a component renders
**different element types** at the same logical position (e.g. `<Fragment>` vs
`<div>`, or two different host tags / components) and the choice is gated on a
`useState` value that a `useEffect` / `useLayoutEffect` **flips after mount**,
the subtree is *structurally guaranteed* to be torn down and rebuilt on every
mount — never updated in place. The initial render uses the constant initial
state; the post-mount effect flips it; React sees a type change at that position
and remounts the whole subtree.

This was the just-diagnosed **SlotRender remount-amplification** bug
(`render-slot.tsx`: `const [horizontal] = useState(false)` flipped by a
`useLayoutEffect([])`, driving `horizontal ? <div className="flex…"> :
<Fragment>` → 238 DOM nodes destroyed on a single transcript mount; fixed in
commit `e595f7f89` by always rendering a `<div>` and toggling
`className` between `"contents"` and `"flex…"`). The same class also hit
`reorder` (`d05a5ffab`/`0bf515520`) and `jsonl-pane` (`117240552`).

The bug is invisible in code review and expensive to find at runtime. This plan
adds a **contributed ESLint rule** that flags the precise shape, steering authors
to toggle `className`/props on a **stable** element instead. It is the structural
twin of `context-safety/no-unstable-context-value` (commit `ae6a9af6f`) for the
render-identity bug class.

**Scope decision (confirmed with user): ternary form only.** Flag
`state ? <A/> : <B/>` where the two branches are different element *types* and
`state` is a post-mount-only `useState`. The early-return form
(`if (state) return <A/>; return <B/>`) is left as a documented, accepted false
negative — too heuristic to detect at "same position" without false positives,
and the build runs plugin rules as `error`.

## Detection (the rule)

Two halves must **both** hold for a report. The rule favors **false negatives
over false positives** (a false positive breaks the build), matching the stance
of `no-reactive-server-io`.

### Half 1 — "post-mount-only" state variable

A `useState` whose setter's *only* call sites are inside `useEffect` /
`useLayoutEffect` callbacks (so the value deterministically flips after mount,
never via user interaction).

- Detect `useState` calls: `CallExpression` whose callee name is `useState`
  (Identifier) or `React.useState` (`MemberExpression.property.name`). Parent
  must be a `VariableDeclarator` with `id.type === "ArrayPattern"` and two
  Identifier elements → `[stateId, setterId]`. Skip otherwise.
- Resolve `setterId` to its scope `Variable` (via
  `context.sourceCode.getScope` + `ASTUtils.findVariable`). Iterate
  `setterVar.references`:
  - A reference is a **call site** when `ref.identifier.parent` is a
    `CallExpression` with the identifier as `callee`.
  - If the setter appears as a **non-call reference** (passed as a value, e.g.
    `onChange={setX}`) → we can't trace it → **not provably effect-only** → skip
    this state (favor false negative).
  - For each call site, walk parents to test "inside an effect": reuse the
    `isEffectHookCall` + ancestor-walk pattern from
    `no-reactive-server-io.ts:74-84,291-307` — an ancestor `ArrowFunction`/
    `FunctionExpression` that is `arguments[0]` of a `useEffect`/`useLayoutEffect`
    call. (Setter nested in a listener/observer/`.then()` created *inside* the
    effect still resolves to "inside effect" — still post-mount. Correct.)
  - Qualify only if **≥1 call site exists AND every call site is inside an
    effect**. (No setter call ⇒ never flips ⇒ no remount ⇒ skip.)
- Record the **state `Variable`** (not the name — name collisions across
  components are resolved by identity) in a `postMountStates: Set<Variable>`.

### Half 2 — ternary swapping element TYPE on that state

A `ConditionalExpression` (ternary) whose `test` references a post-mount state
variable and whose `consequent`/`alternate` are JSX of **different element
types**.

- Link conditional ↔ state by **variable identity**: for each post-mount state
  `Variable`, walk its read `references`; for each read, ascend until the node's
  parent is a `ConditionalExpression` and the node is exactly that conditional's
  `.test` (covers `state`, `!state`, `state && x`, `state === "y"` — anything in
  the test subtree). A read that lands in a branch (`.consequent`/`.alternate`),
  not the test, is ignored.
- `elementType(node)` classifier on each branch:
  - `JSXFragment` (`<>…</>` or `<Fragment>`) → `{kind:"fragment"}`
  - `JSXElement` → `{kind:"element", name: stringifyJSXName(openingElement.name)}`
    where `stringifyJSXName` handles `JSXIdentifier` (`div`),
    `JSXMemberExpression` (`Foo.Bar`), `JSXNamespacedName`.
  - anything else (`null`, string, identifier, another ternary) → `null`.
- **Report only when both branches classify non-null and differ.** Cases that
  stay silent by design (all favor false negatives / are legitimate):
  - `state ? <A/> : null` — conditional mount/unmount, not a type swap.
  - `state ? <div className="a"/> : <div className="b"/>` — **same** type; this
    is exactly the prescribed fix, must never flag.
  - `state ? <A/> : someVar` — a branch we can't classify.
- Message steers to the fix: render one stable element and toggle
  `className`/props (e.g. `className={state ? "flex…" : "contents"}`) instead of
  swapping the element type.

### Why no false positives on existing code

The repo's only ternary element-type swaps today are **prop-driven**
(`element-picker/ui-context-tag.tsx:10` on `meta`,
`inline-text.tsx:41` on `className`), not effect-only `useState` — Half 1 filters
them out. The confirmed `render-slot` case is already fixed. So the rule lands
clean at `error` with no new violations to repair (implementation must still run
it repo-wide to confirm — see Verification).

## Files to create

New contributed lint sub-plugin, mirroring `context-safety/` byte-for-byte in
shape (`ae6a9af6f`):

```
plugins/framework/plugins/tooling/plugins/lint/plugins/element-type-safety/
  package.json          # name @singularity/plugin-…-element-type-safety, mirror context-safety/package.json
  CLAUDE.md             # one-line description block (matches codegen format)
  lint/
    index.ts            # default export { name: "element-type-safety", rules: { "no-post-mount-element-type": rule } }
    no-post-mount-element-type.ts        # the rule
    no-post-mount-element-type.test.ts   # RuleTester suite
```

- **`lint/index.ts`** — exact shape of
  `context-safety/lint/index.ts` (`{ name, rules }`).
- **Rule** (`no-post-mount-element-type.ts`) — `ESLintUtils.RuleCreator` with the
  same doc-URL factory used by the sibling rules; `meta.type: "problem"`,
  `schema: []`, one `messageId`. Visitor collects `useState` declarations and
  `ConditionalExpression`s during traversal, then analyzes on **`Program:exit`**
  (needs all setter references resolved before classifying). No TypeScript type
  checker required — purely structural, like `no-unstable-context-value`.
- **Test** — `RuleTester` + `@typescript-eslint/parser` with
  `ecmaFeatures: { jsx: true }`, run under `bun test`, `RuleTester.run(...)` at
  module top level (see `no-unstable-context-value.test.ts`). Cases:
  - *invalid*: `useState(false)` flipped in `useLayoutEffect`/`useEffect` driving
    `s ? <div…/> : <Fragment/>`; `<>` form; different host tags (`<div>` vs
    `<span>`); different components (`<Foo/>` vs `<Bar/>`); `!state` test;
    setter inside a listener created in the effect.
  - *valid*: same-type both branches (`<div a/>` vs `<div b/>`); `state ? <A/> :
    null`; setter also called in an `onClick` (not effect-only); setter passed as
    a value (untraceable); state-test inside a branch not the test; prop-driven
    ternary (no `useState`); a plain `useState` set in an event handler.

## Files NOT hand-edited (regenerated by `./equin build`)

- `plugins/framework/plugins/tooling/plugins/lint/core/lint.generated.ts` — picks
  up the new sub-plugin (the collected-dir codegen adds one `lintEntries` line).
- `plugins/framework/plugins/tooling/plugins/lint/CLAUDE.md`,
  `docs/plugins-compact.md`, `docs/plugins-details.md` — doc regen.
- `bun.lock` — new sub-plugin package.

Do not edit these by hand; `./equin build` regenerates them from the
filesystem and the `plugins-registry-in-sync` / `plugins-doc-in-sync` checks
enforce it.

## Verification

1. **Unit tests** (fast inner loop):
   ```bash
   bun test plugins/framework/plugins/tooling/plugins/lint/plugins/element-type-safety/lint/no-post-mount-element-type.test.ts
   ```
   (run after a `bun install` / any `./equin` invocation so `node_modules`
   is populated). All valid/invalid cases pass.
2. **Build + register the rule repo-wide:**
   ```bash
   ./equin build
   ```
   This regenerates `lint.generated.ts`, the docs, and runs `./equin check`
   (incl. `type-check`, which runs the ESLint config). A green build proves the
   rule loads, activates as `error` everywhere, and flags **no** existing code
   (matching the analysis above). If it surfaces a real violation, fix that site
   the prescribed way (stable element + `className`/prop toggle, e.g.
   `"contents"` for the layout-neutral branch) and rebuild.
3. **Negative control** — temporarily reintroduce the pre-fix
   `render-slot.tsx` ternary (`horizontal ? <div className="flex…"> :
   <Fragment>`) in a scratch file and confirm the rule fires; revert.

## Notes / escape hatch

If an author *intends* a remount on a post-mount state change (rare), the
standard `// eslint-disable-next-line element-type-safety/no-post-mount-element-type --
<reason>` escape hatch applies — consistent with `no-reactive-server-io`'s
"disable with a reason" stance. The message text should mention this.
