# One class-token walk, injected — closing the reach holes in `no-adhoc-layout` and its 16 siblings

## Context

The `no-adhoc-*` class rules only see a class string at two authoring positions:
a `className`/`class`/`*ClassName` JSX attribute, and a `cn()`/`clsx()`/`twMerge()`
argument. Reaching *through* an identifier to the string behind it is the job of
`collectTokens`, and there is no single `collectTokens` — there are **seventeen**,
one hand-copied into each rule file.

Six of them (typography, radius, z-layers, control, density, slot-icon-size) carry
the current walk, fenced by `// >>> shared:class-token-walk` sentinels and held
byte-identical by the `class-token-walk-in-sync` check. That walk resolves a
same-file identifier into an object/array-literal **map** (`cn(TONE[tone])`).

The other **eleven carry an older copy that resolves no identifiers at all** —
including `no-adhoc-layout`, the rule this investigation started from. They sit
outside the sync check, so nothing ever told anyone they had drifted:

```
plugins/primitives/plugins/css/lint/no-adhoc-layout.ts
plugins/primitives/plugins/css/plugins/spacing/lint/no-adhoc-spacing.ts
plugins/primitives/plugins/css/plugins/surface/lint/no-adhoc-surface.ts
plugins/primitives/plugins/css/plugins/row/lint/{no-adhoc-row,no-row-focus-class}.ts
plugins/primitives/plugins/css/plugins/badge/lint/{no-adhoc-chip,no-badge-text-transform}.ts
plugins/primitives/plugins/css/plugins/text/lint/no-clip-without-nowrap.ts
plugins/primitives/plugins/css/plugins/viewport-overlay/lint/no-adhoc-viewport-overlay.ts
plugins/primitives/plugins/bar/lint/no-adhoc-bar.ts
plugins/primitives/plugins/pane-toolbar/lint/no-adhoc-pane-toolbar.ts
```

### What actually escapes today — measured, not estimated

I ran the layout rule's own token set over the repo three times (baseline walk /
+map-alias / +string-const), with the layout allowlist applied, and diffed:

**Map aliases (the 6 sentinel rules already catch these; `no-adhoc-layout` does not) — 2 files:**

| site | const | tokens missed |
|---|---|---|
| `apps-core/surface/web/components/surface-body.tsx:303` | `FRAME_CLASS` | `absolute` `fixed` `inset-0` `overflow-hidden` |
| `primitives/bar/web/internal/bar.tsx:88` | `TIER_CLASS` | `min-w-0` |

`FRAME_CLASS` is the exact recipe the `2026-08-17` guardrail plan moved there on
purpose — the host owns the geometry so contributors can't spell it. It is correct
that it lives there, and correct that *no rule can currently read it*.

**Standalone string consts (NO rule catches these — the walk excludes them by design) — 4 files:**

`page/editor/…/block-row.tsx` · `primitives/adaptive-bar/…/adaptive-bar.tsx` ·
`primitives/surface-overlay/…/surface-overlay.tsx` ·
`primitives/syntax-highlight/…/highlighted-code.tsx`

### The finding that reframes this

`block-row.tsx:18-23` says out loud why the string is hoisted:

> Keep it hoisted rather than inlined into the JSX — inline it becomes a
> `className` literal that `layout/no-adhoc-layout` reports, and the only escape
> there is a positional directive inside a JSX attribute, which a format pass can
> displace.

An author moved a class string out of the rule's reach because the sanctioned
escape was less durable than evasion. **The hazard named there has since been
cured** — `lint-directives-stable` now refuses to write a file whose directives a
format pass would displace. The reason is stale; the hoist, and the hole it opened
for every class rule, is not.

That is the generalisation: a rule anchored on a *position* teaches authors where
the position isn't. `reportUnusedDisableDirectives: "error"` catches this only when
a directive was left behind — which is how hole #1 surfaced, and why the
`summary-pane.tsx` / `no-reactive-server-io` case surfaced too. It is a detector of
last resort, not a guard.

### The whole reachable-const corpus

Following string consts is not free, so I enumerated every same-file string/template
const reachable from a class context: **47 reads across ~25 distinct consts**. The
walk's authors excluded them for a real reason — most are not layout:

- ~8 mono/code metric consts (`monoLogClass`, `METRICS`, `MONO_FIELD`,
  `SOURCE_METRICS`, `MONO_LOG_CLASS`, `logViewerClass`, …) all spelling
  `font-mono text-xs leading-5`. Both `text-xs` and `leading-5` are banned by
  `no-adhoc-typography`, which has **zero allowlist**.
- `NATIVE_CONTROL` (2 files) — `rounded-md` + `px-xs py-2xs` + `text-body`.
- The rest are colour/state strings that trip nothing.

The mono family repeating eight times *is* the finding: `TextVariant` has
`title | heading | subheading | body | label | caption | eyebrow` and **no code
role**. Eight files hoisted a metrics string because the primitive has no name for
it.

## Approach

Three changes, one theme: the walk stops being something a rule *has* and becomes
something a rule *is given*.

### 1. One walk, injected (rung 1 — the weaker copy becomes unspellable)

Rule files cannot cross-plugin `import` a runtime value: they are dual-loaded under
jiti (which can't resolve `@plugins/*`) and Bun. That constraint is why the walk is
duplicated at all.

**But jiti erases `import type`.** I verified this directly — a module importing a
type from a nonexistent `@plugins/does/not/exist/core` loads clean under jiti. So a
rule file can take the *type* from the real module and the *value* by injection.

- New `plugins/framework/plugins/tooling/plugins/lint/core/class-token-walk.ts`,
  exported from that plugin's `core/index.ts` alongside `buildLintConfig`. It holds
  the one `collectTokens` and the shared `CLASS_ATTRS` / `CLASS_BUILDERS` / `baseClass`
  constants the seventeen copies each re-spell.

- A rule file default-exports a **factory**, not a rule module:

  ```ts
  import type { LintToolkit } from "@plugins/framework/plugins/tooling/plugins/lint/core";

  export default ({ collectTokens, CLASS_ATTRS, baseClass }: LintToolkit) =>
    createRule({ /* unchanged body */ });
  ```

- The plugin's `lint/index.ts` declares them under a **separate key** so there is no
  guess about whether a function value is a legacy rule:

  ```ts
  export default {
    name: "layout",
    rules: {},                                   // plain rule modules, as today
    classRules: { "no-adhoc-layout": noAdhocLayout },  // factories
    ignores: { "no-adhoc-layout": [ … ] },
  };
  ```

- `build-lint-config.ts` (`loadContributions`) builds the toolkit once and merges
  `classRules` into `rules` after calling each factory. Its existing fail-loud
  validation (`enforceEverywhere` naming an unknown rule, a barrel missing
  `{ name, rules }`) extends to cover both keys.

- **Delete** `checks/plugins/class-token-walk-in-sync/` and replace it with
  `class-token-walk-single-source`: fail if any `plugins/**/lint/*.ts` declares its
  own `collectTokens`. An absence assertion over 17 files, instead of a
  byte-comparison over 6 — and it covers the eleven the old check never saw.

Rule tests (`no-adhoc-layout.test.ts` and ~9 siblings) each gain one line: import the
real toolkit — `@plugins/*` resolves under Bun — and call the factory.

### 2. The walk follows standalone string consts

Add `Literal` / `TemplateLiteral` initializers to the identifier branch, alongside
the object/array maps it already follows. Same same-file-only, `seen`-cycle-guarded
resolution; still only ever entered from a real class context, so a doc-string
mentioning `flex` stays untouched. Update the walk's doc-comment, which currently
states the exclusion as deliberate.

### 3. Drain what that surfaces

Roughly 20 new reports, all real by their own rules' definitions:

- **Add a `code` role to `TextVariant`** — `text-code` / `text-code-compact`
  `@utility` in `app.css` backed by the typography token group, mirroring the
  existing variants (`css/plugins/text/web/internal/text.tsx`, both `VARIANT_CLASS`
  and `COMPACT_VARIANT_CLASS`). Migrate the ~8 mono-metrics consts onto it. This is
  the drain paying for itself: eight files stop re-deriving code typography.
- **`surface-body.tsx` `FRAME_CLASS`, `bar.tsx` `TIER_CLASS`,
  `surface-overlay.tsx`, `adaptive-bar.tsx`** — these own the mechanics the rules
  redirect *to*. Named per-site disables, or extend the layout barrel's PERMANENT
  ignores tier the same way `floating-action` and `cursor-menu` are listed.
- **`block-row.tsx`** — delete the stale hoist rationale and take a per-site
  disable with the real reason (JS-driven coords, `.block-anchor` owns the seat).
  `lint-directives-stable` now keeps it bound.
- **`NATIVE_CONTROL`** (`fields/date/filter`, `primitives/date-picker`) — route
  through the existing radius/spacing primitives or take named disables.

Do the drain **before** flipping the walk in the same change, so the tree is never
red between steps.

## Files

**New:** `framework/tooling/plugins/lint/core/class-token-walk.ts` ·
`checks/plugins/class-token-walk-single-source/check/index.ts`

**Deleted:** `checks/plugins/class-token-walk-in-sync/`

**Changed, one mechanical shape each:** the 17 rule files listed above (factory
signature, local walk deleted) · their 10 `lint/index.ts` barrels (`classRules` key)
· their ~10 `*.test.ts` (call the factory) ·
`framework/tooling/plugins/lint/core/{build-lint-config,index}.ts` ·
`css/plugins/text/web/internal/text.tsx` + `app.css` (the `code` role) · the ~14
drain sites.

## Verification

1. `./equin check type-check` — the whole rule set still loads and type-checks.
2. `bunx eslint <one file>` — **the load-bearing check.** This is the jiti path; if
   a type-only import were ever emitted as a runtime import, it fails here and not
   in the Bun-loaded worker.
3. `./equin test plugins/primitives/plugins/css plugins/primitives/plugins/bar plugins/primitives/plugins/pane-toolbar` — rule tests.
4. `./equin check` — `class-token-walk-single-source` passes, and
   `class-token-walk-in-sync` is gone from `check --list`.
5. **Prove the holes are closed, don't assume it.** Re-run the three-mode probe
   (baseline / +maps / +string-consts) used to measure this: with the shipped walk
   as baseline, the mode diffs must be empty. That is the only evidence that the
   escapes are gone rather than merely re-hidden.
6. `./equin build`, then confirm the drained surfaces are visually unchanged —
   the code blocks and log viewers that moved onto `<Text variant="code">`
   (`build-logs`, `page/code-block`, `syntax-highlight`), the surface placements,
   and the page editor's block anchors.

## Risks

- **jiti erasure is the whole design.** Verified for `import type`, which the
  transpiler drops unconditionally. Rule files must use the `import type { … }`
  form, never `import { type … }`, which `verbatimModuleSyntax` can preserve. Worth
  a line in the toolkit's doc-comment and a sentence in
  `framework/tooling/plugins/lint/CLAUDE.md`.
- **`no-adhoc-spacing` and the other nine also gain map-alias reach** for the first
  time. My probe measured the layout token set only; the drain list above may grow
  once they see maps. Re-run the probe per rule before the flip and fold the result
  into the drain.
- The `code` text role is a real token-group addition — it needs the light/dark and
  compact rungs the other variants have, not just a class alias.
