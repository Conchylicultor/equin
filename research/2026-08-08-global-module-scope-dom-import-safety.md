# Module-scope DOM reads make `web/` modules unimportable under `bun test`

Date: 2026-08-08 · Category: global (primitives, build, framework/tooling)

## Context

`bun test plugins/page` reports 2 failures in the two sibling collab round-trip
tests:

- `plugins/page/plugins/inline-date/web/internal/collab-roundtrip.test.ts`
- `plugins/page/plugins/inline-page-link/web/internal/collab-roundtrip.test.ts`

Both fail at module evaluation, before any assertion runs. They are pre-existing
and unrelated to the todo-dispatch work that surfaced them.

### One root cause, wearing two masks

`plugins/primitives/plugins/log-channels/web/components/live-log-channel.tsx:27`
reads `window.location` **at module scope**:

```ts
const WS_URL = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws/logs`;
```

Any runtime without a DOM dies the moment that module is imported. Both tests
reach it through a chain that is entirely legitimate under the repo's
barrel-only import rule:

```
inline-page-link/web/internal/register.ts
  -> inline-page-link/web/components/page-link-inline-node.tsx
  -> primitives/live-state/web/index.ts
  -> primitives/live-state/web/notifications-client.ts   (wants only `clientLog`)
  -> primitives/log-channels/web/index.ts                (barrel drags in the UI component)
  -> primitives/log-channels/web/components/live-log-channel.tsx   ← throws
```

Run either test file alone and you get the honest error:
`ReferenceError: window is not defined`.

The confusing second error is a downstream artifact of the first. `bun test`
runs both files in **one process** with a shared module cache. The `inline-date`
file runs first; its import chain has already begun evaluating
`plugins/page/plugins/editor/web/internal/block-text-extensions.ts` (via the
editor barrel) when the `window` throw aborts the chain. That module is left
**partially evaluated** in the cache: its hoisted function declarations exist,
but its `const extensions: BlockTextExtension[] = []` never initialized. The
`inline-page-link` file then imports the cached partial module and calls
`registerBlockTextExtension`, which touches `extensions` — still in its temporal
dead zone:

```
ReferenceError: Cannot access 'extensions' before initialization.
  at registerBlockTextExtension (…/editor/web/internal/block-text-extensions.ts:75:3)
  at …/inline-page-link/web/internal/register.ts:12:1
```

So there is **no import cycle and nothing wrong with the editor plugin** — the
TDZ error is purely the shape the first failure takes on the second file.

Verified: making that one line lazy turns `bun test plugins/page/plugins/inline-date
plugins/page/plugins/inline-page-link` from `2 fail` into `23 pass / 0 fail`.
(The change was reverted; the tree is clean.)

### Why fix the modules rather than stub a DOM in the test harness

The repo does have a sanctioned fake-DOM: `registerBarrelStubs()` in
`plugins/plugin-meta/plugins/barrel-import/core/internal/stubs.ts:37-78` installs
a fake `globalThis.window`/`document` so docgen and `./equin check` can
genuinely `await import()` every `web/` barrel. It is opt-in per caller and is
deliberately **not** wired into `bunfig.toml`'s `[test] preload`
(`test/bun-preload.ts` only defaults `SINGULARITY_WORKTREE`).

Importing it into the test preload would hide the defect rather than remove it:
a module that needs a live `window` at *evaluation* time is broken for every
non-DOM consumer, and `bun test` would silently start depending on a half-DOM —
against the runner split, where DOM-dependent work belongs to vitest/jsdom
(`bunfig.toml` excludes `**/web/__tests__/**` precisely to keep the two apart).

The correct invariant is the one every SSR/bundler ecosystem enforces:
**module evaluation must not touch browser globals.** Reading them inside a
function, hook, or component body is fine.

### The duplication behind it

The same derivation is copy-pasted at four sites — and
`live-log-channel.tsx:55` already claims it consolidated them ("its own `WS_URL`
derivation … three places for the same off-by-one to be wrong in"), which is now
untrue:

| file | line | socket |
| --- | --- | --- |
| `plugins/primitives/plugins/log-channels/web/components/live-log-channel.tsx` | 27 | `/ws/logs` |
| `plugins/build/web/components/build-popover-content.tsx` | 38 | `/ws/logs` |
| `plugins/build/plugins/build-logs/web/components/build-log-section.tsx` | 108 | `/ws/logs` |
| `plugins/primitives/plugins/terminal/web/components/terminal.tsx` | 11 | `/ws/terminal` |

All four already import `@plugins/primitives/plugins/networking/web` for
`useReconnectingWebSocket`, so consolidating there adds **no new dependency
edge**.

## Plan

### 1. Add `wsUrl(path)` to the networking primitive

New internal file `plugins/primitives/plugins/networking/web/ws-url.ts`, exported
from `plugins/primitives/plugins/networking/web/index.ts` alongside
`useReconnectingWebSocket`:

```ts
/**
 * Absolute `ws(s)://` URL for a same-origin socket path.
 *
 * A function, not a module-scope const: reading `window.location` during module
 * evaluation makes the importing module unloadable in any non-DOM runtime
 * (`bun test`, docgen), which is what `no-module-scope-dom` enforces.
 */
export function wsUrl(path: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${path}`;
}
```

`networking` is the right owner: it already owns `WebSocketLike`,
`SharedWebSocket`, and `useReconnectingWebSocket`, and sits below all four
consumers.

### 2. Route all four sites through it

Delete each module-scope `const WS_URL = …` and call `wsUrl(...)` where the URL
is consumed — in the render body, next to the existing
`useReconnectingWebSocket({ url: … })` call:

```diff
-const WS_URL = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws/logs`;
…
-    url: WS_URL,
+    url: wsUrl("/ws/logs"),
```

`ReconnectingWsOptions.url` is a plain `string` consumed inside the hook's
`useEffect` (`networking/web/use-reconnecting-ws.ts:5-10,28`), and `wsUrl()`
returns an identical string every render, so effect identity is unaffected.

While in `live-log-channel.tsx`, correct the now-false claim in its doc comment
(line 55) that it is the single home of the `WS_URL` derivation — after this
change it genuinely is, via `wsUrl`.

### 3. New lint rule: `no-module-scope-dom`

New sub-plugin
`plugins/framework/plugins/tooling/plugins/lint/plugins/dom-access-safety/`,
mirroring `resize-observer-safety/` byte-for-byte in shape:

```
dom-access-safety/
  package.json          # @singularity/plugin-framework-tooling-lint-dom-access-safety
  CLAUDE.md             # prose + AUTOGENERATED block (regenerated by ./equin build)
  lint/index.ts         # default export { name, rules, ignores }
  lint/no-module-scope-dom.ts
```

`lint/index.ts`:

```ts
import noModuleScopeDom from "./no-module-scope-dom";

export default {
  name: "dom-access-safety",
  rules: { "no-module-scope-dom": noModuleScopeDom },
  ignores: {
    // Vite browser entry points: reached only by a <script type="module"> tag,
    // never by a static import, so they cannot enter a bun:test module graph.
    "no-module-scope-dom": [
      "plugins/framework/plugins/web-core/web/main.tsx",
      "plugins/primitives/plugins/css/plugins/layout-harness/web/internal/entry.tsx",
    ],
  },
};
```

Rule behavior:

- **Banned names**: `window`, `document`, `navigator`, `localStorage`,
  `sessionStorage`, `matchMedia`.
- **Scope**: only files matching `plugins/**/web/**`, tested via
  `context.filename`. Contributed rules are applied repo-wide at
  `**/*.{ts,tsx}` (`lint/core/build-lint-config.ts:295-296`), so path scoping
  must live inside `create()`.
- **Detection**: read `context.sourceCode.scopeManager.globalScope.through` (the
  file's unresolved references), keep those whose name is banned, and report only
  when no ancestor scope of `ref.from` is a function scope — i.e. the reference
  really is evaluated at import time. This catches every module-scope shape
  (declarations, top-level `if`, bare expression statements, `new WebSocket(...)`
  initializers), not just `const`/`let`/`var`.
- **Allowed**: any read inside a function, arrow, method, or class body — the
  overwhelmingly common case, which must stay silent.
- **Also allowed**: module-scope reads guarded by `typeof <name> !== "undefined"`.
  Skip a reference that is itself the operand of a `typeof`, or that sits inside
  an `IfStatement.test` / `ConditionalExpression.test` / `&&`-left guard testing
  the same name. These degrade to a no-op rather than throwing, and three
  legitimate sites rely on it:
  `primitives/pane/web/pane.ts:959`,
  `conversations/plugins/pane-restore/web/internal/pane-restore-store.ts:120`,
  `primitives/shortcuts/web/internal/parse-keys.ts:4`.
- **Message**: name the failure mode, not just the ban — reading a browser
  global during module evaluation makes the module unloadable under `bun test`
  and docgen; move the read into the function that needs it, or guard it with
  `typeof x !== "undefined"`.

After the three fixes in §2 plus the two `ignores` entries, the rule is green on
a clean tree — confirmed by an AST sweep of all 378 candidate `web/` files, which
found exactly the 6 unguarded module-scope reads (the 4 `WS_URL` sites + the 2
Vite entries) and the 3 guarded ones above.

### 4. Regenerate

A new plugin folder makes `plugins-registry-in-sync` and `plugins-doc-in-sync`
fail until `./equin build` regenerates:

- `plugins/framework/plugins/tooling/plugins/lint/core/lint.generated.ts`
- `docs/plugins-compact.md`, `docs/plugins-details.md`
- the new plugin's own `CLAUDE.md` AUTOGENERATED block and the sub-plugin list in
  `plugins/framework/plugins/tooling/plugins/lint/CLAUDE.md`

Root `workspaces` is `["plugins/**"]`, so the new `package.json` also needs a
`bun install` to be linked.

## Out of scope

`build-popover-content.tsx` and `build-log-section.tsx` both hand-roll a
`/ws/logs` subscription that `LiveLogChannel` already implements. Folding them
into that primitive is the real deduplication, but it is a behavioral refactor of
the build UI and does not belong in a test-fix change. Worth a follow-up task.

## Verification

1. The two originally-failing files, together in one process (this is the
   ordering that produced the TDZ error — running either alone does not):

   ```bash
   bun test plugins/page/plugins/inline-date plugins/page/plugins/inline-page-link
   ```

   Expect `23 pass / 0 fail`, no `# Unhandled error between tests` block.

2. The whole suite the report came from:

   ```bash
   bun test plugins/page
   ```

   Expect the previously-green 936 plus the 2 recovered, and **no** `window is
   not defined` or `Cannot access 'extensions' before initialization`. Note the
   DB-backed suites under `plugins/page/plugins/editor*/server/` fail without a
   running worktree DB (`Cannot use a pool after calling end on the pool`,
   `beforeEach` timeouts) — environmental, unrelated, and expected to persist
   until after a `./equin build`.

3. The lint rule fires where it should and nowhere else:

   ```bash
   ./equin check eslint
   ./equin check          # registry + doc sync, boundaries, type-check
   ```

   Then hand-verify the rule by temporarily restoring one `const WS_URL = …` line
   and confirming `no-module-scope-dom` reports it.

4. Nothing regressed in the browser, where all four sockets actually connect:

   ```bash
   ./equin build
   ```

   Confirm `~/.singularity/worktrees/<worktree>/build-status.json` shows
   `status: ok`, then at `http://<worktree>.localhost:9000` open the build
   popover (live build log streams), a Studio release log section, and a terminal
   pane — each should connect and stream, proving `wsUrl()` produces the same URL
   the module-scope const did.
