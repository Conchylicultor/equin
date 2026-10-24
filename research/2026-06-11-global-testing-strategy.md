# Global Testing Strategy

## Context

While fixing the web-core vitest load failures (the `setupFiles` path bug, already
landed in `3ab510e74`), several deeper problems surfaced that mean the project has
**no coherent, runnable test strategy**:

1. **Two test runtimes, undocumented split.** Of 21 `*.test.ts(x)` files, **18 use
   `bun:test`** and **3 use `vitest`**. Nothing documents which runner owns what, or
   how to run a suite. The lint tests even self-document "Run with `bun test`", but
   that intent lives nowhere central.
2. **Vitest is over-used.** Only **one** of the three vitest files genuinely needs a
   browser environment (`plugin-render.test.tsx` — jsdom + React + web-core's `@/`
   alias + the whole plugin graph). The other two (`utils.test.ts`,
   `merge-group-values.test.ts`) are pure-logic tests mis-filed under vitest.
3. **`plugin-render.test.tsx` is architecturally impossible.** It bare-renders every
   plugin contribution (`<Component />`, no props/context). That premise cannot hold:
   it exceeds the 5s default timeout loading the whole graph, and dozens of
   contributions legitimately crash (tag renderers need a `content` prop; many need
   `NotificationsProvider`, the pane layout renderer, or `localStorage`). It has
   never passed.

**Decision (from the user):** tests stay **manual and optional**. Agents run specific
files/folders explicitly; there is **no global test run and no `./equin check`**
that executes suites. This plan documents the convention, fixes the mis-filed tests,
and rewrites the broken smoke test into a load-only smoke.

## Strategy

### Runner convention (documented, not enforced)

- **`bun:test` is the default runner** for all pure-TS / logic / lint / check / server
  / web-logic tests. Bun natively resolves the `@plugins/*` tsconfig path and runs
  with zero config. Run a specific file or folder:
  ```bash
  bun test plugins/page/plugins/editor/core/block-ops.test.ts
  bun test plugins/page/plugins/editor          # a folder
  ```
- **`vitest` is reserved for browser/DOM + React tests** that need jsdom, web-core's
  `@/` SPA alias, CSS imports, and the vite transform. After this plan there is
  exactly **one** such suite (`plugin-render.test.tsx`). Run it via web-core's `test`
  script (which already exists):
  ```bash
  cd plugins/framework/plugins/web-core && bun run test
  # single file:
  cd plugins/framework/plugins/web-core && bun run vitest run web/__tests__/plugin-render.test.tsx
  ```
- **Tests are optional.** Nothing runs them in `build`, `push`, or CI. There is no
  blanket root `bun test` target — always pass an explicit path. (A blanket root
  `bun test` would also try to load the one vitest file and fail; if ever needed, pass
  `--path-ignore-patterns='**/web-core/web/__tests__/**'`.)
- **Prerequisite:** the worktree's `node_modules` must be populated. Any
  `./equin` invocation runs `bun install --silent`, and `./equin build`
  installs as step 1 — so run tests after at least one build, or run `bun install`
  first.

### Why no single unified runner

`bun:test` and `vitest` are genuinely different runtimes: `bun:test` files import the
`bun:test` module (only exists under the bun runner) and `vitest` files import the
`vitest` module (only exists under the vitest runner). Neither runner can execute the
other's files. The DOM suite additionally needs vite's transform (`@/` alias, `.css`
imports, full plugin graph) which bun's test runner can't provide. So the split is
intrinsic — the strategy is to **document the boundary and minimize the vitest side to
the single suite that truly needs it.**

## Changes

### 1. Convert the two mis-filed vitest tests to `bun:test`

Both are pure logic with no DOM dependency — moving them off vitest leaves exactly one
vitest suite and makes the `.test.ts → bun:test` convention clean.

- `plugins/framework/plugins/web-core/web/lib/utils.test.ts`
  - `import { it, expect } from "vitest";` → `import { it, expect } from "bun:test";`
  - `import { cn } from "@/lib/utils";` → `import { cn } from "./utils";` (colocated;
    `@/*` maps to `./web/*`, so `@/lib/utils` is the sibling `./utils`).
- `plugins/ui/plugins/theme-engine/web/internal/merge-group-values.test.ts`
  - `import { it, expect } from "vitest";` → `import { it, expect } from "bun:test";`
    (relative imports only; no other change).
- `plugins/ui/plugins/theme-engine/package.json` — drop the now-unused `vitest`
  devDependency.

Verify each still passes: `bun test <file>`.

### 2. Rewrite `plugin-render.test.tsx` → load-only smoke

`plugins/framework/plugins/web-core/web/__tests__/plugin-render.test.tsx`

Drop the bare-render loop entirely (it tests something the architecture forbids).
Assert the real value: the whole web plugin graph **loads** without import/registration
errors, and every contribution is structurally well-formed. No rendering, no
providers, no `@testing-library/react`. Keep it under vitest (it still imports the full
graph — `@/` alias, `.css`, jsdom-touching module init — which only vite/jsdom
provide). Raise the timeout well past the 5s default for the graph load.

```tsx
import { it, expect } from "vitest";
import { loadPlugins } from "@plugins/framework/plugins/web-sdk/core";
import { webEntries } from "@plugins/framework/plugins/web-sdk/core/web.generated";

it(
  "all web plugins load without errors and every contribution is well-formed",
  async () => {
    const { plugins, errors } = await loadPlugins(webEntries);
    expect(errors).toEqual([]);
    expect(plugins.length).toBeGreaterThan(0);
    for (const plugin of plugins) {
      for (const contribution of plugin.contributions ?? []) {
        // every contribution must declare the slot it targets
        expect((contribution as Record<string, unknown>)._slotId).toBeTruthy();
      }
    }
  },
  30_000,
);
```

- The web-core `setup.ts` (matchMedia + canvas stubs) and jsdom `environment` stay —
  module-level code in the graph may touch `window` at import time.
- Optionally rename the file to `plugin-load.test.tsx` to match its new intent (it no
  longer renders). Keep `.test.tsx` so the `bun:test` boundary stays "`.test.ts(x)` is
  bun unless it's the web-core DOM suite".

### 3. Document the convention

- **Root `CLAUDE.md`** — add a short **Testing** subsection under `## Instructions`
  stating: tests are optional and manual; `bun:test` is the default runner (run with an
  explicit file/folder path); `vitest` is only for the web-core DOM suite (run via
  `bun run test` in web-core); nothing runs suites automatically; `node_modules` must be
  installed first (any `./equin` call does this).
- **`plugins/framework/plugins/web-core/CLAUDE.md`** — note that this plugin hosts the
  project's only vitest suite (jsdom + React via the vite-merged `vitest.config.ts`),
  what it asserts (load-only smoke), and how to run it.

## Critical files

- `plugins/framework/plugins/web-core/web/__tests__/plugin-render.test.tsx` — rewrite.
- `plugins/framework/plugins/web-core/web/lib/utils.test.ts` — convert to bun:test.
- `plugins/ui/plugins/theme-engine/web/internal/merge-group-values.test.ts` — convert
  to bun:test.
- `plugins/ui/plugins/theme-engine/package.json` — drop unused `vitest` devDep.
- `CLAUDE.md` (root) — add Testing subsection.
- `plugins/framework/plugins/web-core/CLAUDE.md` — document the vitest suite.
- (reference, unchanged) `plugins/framework/plugins/web-core/vitest.config.ts`,
  `web/__tests__/setup.ts` — the one vitest config + setup, already fixed.

## Verification

1. `bun install` (or any `./equin` call) to populate `node_modules`.
2. Converted unit tests pass under bun:
   ```bash
   bun test plugins/framework/plugins/web-core/web/lib/utils.test.ts
   bun test plugins/ui/plugins/theme-engine/web/internal/merge-group-values.test.ts
   ```
3. Rewritten smoke passes under vitest:
   ```bash
   cd plugins/framework/plugins/web-core && bun run vitest run web/__tests__/plugin-render.test.tsx
   ```
   Expect: completes well under 30s, `errors` empty, assertion green.
4. Spot-check an existing bun suite still runs by path:
   ```bash
   bun test plugins/page/plugins/editor/core/block-ops.test.ts
   ```
5. `./equin check type-check` still green (test files remain covered by
   `tsconfig.test.json`; the bun:test conversions don't change types).
6. `./equin build` succeeds (no new check added; build unaffected).
