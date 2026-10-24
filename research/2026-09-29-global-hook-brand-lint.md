# Hook brand + lint: a hook value can only live under a `use*` name

## Context

A pane crashed with React #311. `PaneInternal.resolve` held a hook (`ResolveHook`). `StickyResolveGuard` called it as `resolve(params)`. The React Compiler recognises hooks by name alone, so it treated the call as a pure function and cached it on `(resolve, params)`. On the guard's render-phase `setSawFound` re-render, the cache hit and the resolve hook's own hooks were skipped. `useState` then landed on a `useMemo` slot and React threw #311. The fix was a rename to `useResolve` (commit 964e893311).

This whole class of bug is invisible to `react-hooks/rules-of-hooks` and to the compiler, because both trust the name. Only the TypeScript type knows a value is a hook. The goal is to make "a hook under a non-`use` name" a lint error, using a type brand that the checker can see.

The risk only runs one way. A plain function under a `use*` name just costs some caching, so the lint never needs to judge whether a `use*` name is "legitimate".

## Design

### 1. `Hook<F>`: a new leaf plugin `plugins/framework/plugins/hook-value`

`core/index.ts` exports one type:

```ts
/** A React hook carried as a value. Any binding holding one must be named use*. */
export type Hook<F extends (...args: never[]) => unknown> = F & {
  readonly __hook?: true;
};
```

- **The brand is optional.** Any plain function (`useResolveConversation`, an inline arrow) is assignable with no cast and no mint helper. The declared or inferred type of a binding still carries `__hook`, so the checker can see it. This follows the repo's string-brand convention (`PluginId`, `Namespace`), which a rule can detect with `type.getProperty("__hook")`.
- **The brand propagates through inference.** `const x = props.useFoo`, `const { useFoo: foo } = p` and `a ?? b` all keep `Hook<…>` in the type (a union member counts). Those are exactly the rename sites where this bug is born.
- **Risk to verify first:** TypeScript's weak-type check on `F & { __hook?: true }`. If assigning a plain function errors, fall back to a required phantom brand plus a one-line `hook(fn)` mint at the few declaration inputs.

### 2. Lint rules in `hook-value/lint/` (type-aware, error)

Both rules follow the template in `plugins/primitives/plugins/data-table/lint/no-class-as-grid-width.ts`: `ESLintUtils.getParserServices` and `program.getTypeChecker()`. Union splitting follows `isThenableType` in `tooling/lint/plugins/button-safety/lint/no-async-raw-button.ts`.

- **`hook-value/hook-binding-name`**: a binding whose type (or any union member of it) carries `__hook` must be named `/^use[A-Z0-9]/`. A binding here means:
  - a variable declarator identifier;
  - a destructured binding, including renames;
  - a function or arrow parameter;
  - an interface or type-literal property signature;
  - a class property.

  Object-literal keys are **not** checked. A literal's keys are dictated by the target type's field names, which this rule already checks at their declaration. Message: *"holds a hook (Hook<…>) — name it use*; the React Compiler memoizes non-use calls (React #311)"*.
- **`hook-value/use-field-branded`**: an interface or type-literal property signature, or a component prop type member, that is named `use*` and has a function type must be `Hook<…>`. This closes the set. Declaring a hook field forces the brand, and the brand then forces every downstream binding to keep a `use*` name. Only explicit type annotations are checked. Function declarations (`function useX`) and object literals (`vi.mock` factories) are out of scope.

Tests go in `lint/<rule>.test.ts` with a typed `RuleTester`. Copy the setup from `plugins/primitives/plugins/passthrough/lint/no-unanchored-passthrough.test.ts`, including `tsconfig.case.json` with `types: []`, or the suite takes minutes. Cases:

- Valid: `useX: Hook<…>`, `const useZones = a?.useZones ?? useNoZones`, a plain function passed into a `Hook` field.
- Invalid:
  - `resolve: Hook<…>`;
  - `const decorate = useRowDecoration ?? f`;
  - `const { useResolve: resolve } = p`;
  - `(resolve: ResolveHook) => …`;
  - the original guard prop shape;
  - an unbranded `useFoo: () => T` field.

### 3. Adopt the brand at every hook-typed declaration (≈20 sites, all but pane already `use*`-named)

For each, the field type becomes `Hook<…>`:

- **Pane** (`primitives/pane/web/pane.ts`):
  - `ResolveHook` and `PaneTitleHook` become `Hook<…>` aliases.
  - **Public keys renamed:** `Pane.define({ resolve })` becomes `useResolve`, and `title.text` becomes `title.useText`. That covers about 13 resolve call sites and about 24 title call sites. It is a mechanical codemod, and the internal `args.resolve → useResolve` rename in `definePane` goes away.
  - The paramless `resolve?: never` / `resolve: false` spelling becomes `useResolve`.
  - `title.useText` stays `string | Hook<…>`. A string is not a function, so it doesn't trip the rule, and inline non-hook arrows like `({worktree}) => …` are harmless under a `use` name.
- **detail-sections**: `useAvailable` and `useDefaultOpen`.
- **data-table**: `useRowDecoration`. The fallback `noRowDecoration` becomes `useNoRowDecoration`, and the local `decorate` becomes `useDecorate`.
- **data-view**:
  - `useZones` and `useContributions` (slot method).
  - `useVariants` in the view settings popover.
- **markdown**: `useComponents`, `useTransform`, `useCodeHandler`.
- **active-data**: `useClaim`.
- **health-report**: `useStatus` and `useInfo`, including the component props that forward them.
- **Other plugins**:
  - `tasks/launch-options`: `useTaskBinding`;
  - `auth`: `useEnabled`;
  - `page/place`: `useReady`;
  - `ui/theme-engine`: `useThemes` and `useEntries`;
  - `ui/*`: `useOptions`.
- **fields**:
  - `useVariants`;
  - dynamic-enum's `useOptions`;
  - the shared `useShape` field-renderer type, declared once and branded once.

The lint's first run is the source of truth for anything this inventory missed. `use-field-branded` lists every unbranded `use*` field.

### 4. Knock-on updates

- `plugins/primitives/plugins/live-state/lint/no-pending-data-collapse.ts` pattern-matches `text: useX` inside `Pane.define`. Switch it to `useText`.
- Update the prose in `primitives/pane/CLAUDE.md` and the `Pane.define` docs about `resolve` and `title.text`.
- Regenerate `docs/plugins-*.md` through the build.

## Critical files

- New: `plugins/framework/plugins/hook-value/{core/index.ts, lint/index.ts, lint/hook-binding-name.ts, lint/use-field-branded.ts, lint/*.test.ts, CLAUDE.md, package.json}`
- `plugins/primitives/plugins/pane/web/pane.ts`, `pane/web/components/pane-resolve-guard.tsx`
- The roughly 37 `panes.tsx` call sites (codemod `resolve:` → `useResolve:` and `text:` → `useText:` inside `Pane.define` title specs)
- The declaration sites in §3, and `live-state/lint/no-pending-data-collapse.ts`

## Verification

1. `./equin test plugins/framework/plugins/hook-value` runs the RuleTester suites, both rules, valid and invalid.
2. **Negative control:** temporarily revert the guard to `resolve(params)` (prop named `resolve: ResolveHook`). `./equin check type-check` must fail on `hook-value/hook-binding-name`. Restore it afterwards.
3. `./equin build` must pass, with all checks green, including `type-check`, `plugins-doc-in-sync` and `plugins-registry-in-sync`.
4. Screenshot a resolve-guarded pane, for example a conversation (`/agents/c/<id>`) and a task detail, to confirm there are no runtime regressions from the rename.
