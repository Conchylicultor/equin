# React Compiler Compliance — Drive Violations to Zero & Ratchet to Error

**Date:** 2026-06-23
**Category:** global (frontend / build infrastructure)
**Status:** Plan — phased burndown, ready to execute
**Prerequisite read:** [`2026-06-23-global-react-compiler-adoption.md`](./2026-06-23-global-react-compiler-adoption.md) (the adoption + gate analysis this follows from)

---

## Context

The React Compiler is now enabled repo-wide (`compilationMode: "infer"`) via
`plugins/framework/plugins/tooling/plugins/react-compiler`. It auto-memoizes every
inferred component/hook — but it **silently bails** on any component that violates the
Rules of React, leaving that component un-memoized. The Rules-of-React eslint rules
(shipped in `eslint-plugin-react-hooks`'s `recommended-latest`, all forced to `"warn"`
in `build-lint-config.ts`) are the *only* signal for those silent bails, so the warning
count is the coverage metric.

A fresh scan (`bunx eslint "plugins/**/web/**/*.{ts,tsx}" -f json`, 2026-06-23) found
**510 warnings / 0 errors** across 209 of 2153 web files. They split into three tiers:

| Tier | Rules | Count | Effect |
|---|---|---|---|
| **Coverage-blocking** | `void-use-memo` 5, `purity` 5, `static-components` 3, `use-memo` 3, `immutability` 2, `preserve-manual-memoization` 2, `incompatible-library` 1 | **21 / 19 files** | Compiler **skips** the component (lost memoization) |
| **Long tail** | `refs` 180 (54 files), `set-state-in-effect` 67 (56 files) | **247** | Compiler still compiles; correctness/style only |
| **Out of scope** | `@typescript-eslint/no-unnecessary-condition` 163, unused-disable directives 79 | 242 | Unrelated to the compiler |

**Intended outcome:** bring the codebase into compliance — fix real violations, exempt
the genuinely-justified ones — so (a) compiler coverage is **complete** (every component
compiles), and (b) each rule can be **ratcheted from `"warn"` to `"error"`** so new
violations fail `./equin check` instead of silently eroding coverage. The work is
phased so it can stop cleanly after any phase; **Phase 1 is the high-value core** (it is
literally what "coverage is complete" means and is ~19 small edits).

A per-file diagnosis workflow (24 sub-agents) root-caused every blocking violation and
characterized the long tail; this plan is grounded in those findings.

---

## Goal & phasing

- **Phase 1 — Complete coverage (21 blocking, 19 files).** Fix 18, exempt 1, plus one
  structural helper. Iterate to zero, then ratchet the **7 bail-causing rules to `error`**.
- **Phase 2 — `refs` burndown (180).** Introduce `useLatestRef`, exempt dnd-kit, fix ~5
  genuine anti-patterns, then ratchet `refs` to `error`.
- **Phase 3 — `set-state-in-effect` burndown (67).** Refactor props-to-state / default-
  selection anti-patterns, migrate/ exempt the rest, then ratchet to `error`.

Each phase ends green on `./equin check` and only ratchets a rule once its count is
truly 0.

---

## Exemption mechanism & the correct rule ids (read first)

Two distinct exemption tools — pick by whether memoization can be restored:

1. **Real fix** (preferred) — restructure so the component compiles. Restores memoization.
2. **`"use no memo"` directive** — a string literal as the **first statement of the function
   body** opts that *one* component/hook out of compilation cleanly and self-documents. Use
   when the component genuinely cannot be compiled (library incompatibility, intentional
   stateful machine). This also suppresses the compiler's eslint diagnostic for that function.
3. **Inline `// eslint-disable-next-line react-hooks/<rule> -- <reason>`** — silences *only*
   the lint warning; for a blocking rule the component stays un-memoized, so use this only
   for the deliberate render-phase-side-effect idiom (where there is no JSX/return value to
   memoize and nothing is lost) or for benign long-tail patterns.

> **Rule-id gotcha.** These diagnostics ship under **`react-hooks/*`** in this repo (the
> standalone `eslint-plugin-react-compiler` is deprecated). Disable comments **must** name
> the actual rule — `react-hooks/refs`, `react-hooks/set-state-in-effect`,
> `react-hooks/void-use-memo`, etc. — **not** `react-compiler/react-compiler`.

> **No per-glob seam.** The base `react-hooks/*` rules live in `build-lint-config.ts`
> `baseConfigs[0].rules`, **not** the per-plugin `ignores` mechanism (which only applies to
> *contributed* `name/rule` rules). Genuine exemptions use inline disables / `"use no memo"`
> — consistent with the repo's existing inline `react-hooks/exhaustive-deps` disables. Do
> **not** build a per-glob exemption layer for these; the exempt count is tiny.

---

## Phase 1 — Complete compiler coverage (the 21 blocking violations)

All 19 files diagnosed; 18 are real fixes (15 trivial, 2 small) and 1 is a genuine exempt.
Edits are local and behavior-preserving. Grouped by fix shape:

### 1a. Dynamic capitalized-JSX → `createElement` (`static-components`, 3 files)
A component/icon resolved at render and rendered as `<Component/>` trips the rule. Build the
element instead of capitalizing a local.
- `plugins/active-data/web/internal/active-data-inline-node.tsx:107` — `createElement(UNSAFE_unsealSlotComponent(match.component), { content: text, attrs: {} })`; drop the `const Component`. Keep the greppable `// UNSAFE:` comment.
- `plugins/page/plugins/file/web/components/file-block.tsx:85` — `createElement(iconForMime(mime), { className })`.
- `plugins/primitives/plugins/data-view/web/components/filter/field-picker.tsx:41` — add a module-scope `DynamicIcon({ icon: Icon }) { return Icon ? <Icon/> : null }`; render `<DynamicIcon icon={currentIcon}/>`. **Hoist `DynamicIcon` to `web/internal/`** and reuse it in the sibling `field-search-list.tsx:52/58` (same idiom — will bail once it surfaces).

### 1b. Drop redundant manual memo → let the compiler memoize (`preserve-manual-memoization` 2, `use-memo` 3)
These manual `useMemo`/`useCallback` either pass a non-inline callback, a computed deps array,
or a returned-closure the compiler can't preserve. Deleting them restores compilation *and*
improves the memoization (correct property-level deps).
- `plugins/active-data/web/internal/linkify-active-data.tsx:123` — delete the outer `useMemo`, return the closure directly.
- `plugins/tasks/plugins/task-dependencies/web/components/task-dependencies.tsx:41` — delete all three manual memos (`deps`, `folderCandidate`, `addFolderAsDep`); inline as plain consts/async fn, preserving the `pending`-before-`data` narrowing order.
- `plugins/conversations/plugins/conversation-view/plugins/op-status/web/components/op-status-banner.tsx:46` — delete `useCallback(titleMapOf, [])`; pass module-level `titleMapOf` directly to the three `useResource({ select })` calls.
- `plugins/primitives/plugins/live-state/web/resource-utils.ts:83` — delete `useMemo(() => combineResources(inputs), Object.values(inputs))`; `return combineResources(inputs)`. (Dynamic deps length makes a literal-array fix impossible; removing the memo is the compiler-aligned fix.) **Load-bearing** (`useCombinedResources`, the all-or-nothing readiness gate) — verify the file has no `"use no memo"` and identity stays stable.
- `plugins/tasks/plugins/task-detail/web/context.tsx:57` — delete the no-op `useCallback(fn, [fn])`; use `fn` directly in the effect.

### 1c. Impure clock read in render → move out of render (`purity`, 5 sites / 5 files)
`Date.now()` / `performance.now()` during render makes render non-deterministic.
- `plugins/primitives/plugins/live-state/web/use-resource.ts:199` — **highest value** (this is `useResource`, imported by ~150 plugins, called per-row). Change `useRef(performance.now())` → `useRef<number | null>(null)` and capture `startRef.current = performance.now()` as the first line of the existing mount effect; null-guard the duration read.
- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web/components/jsonl-pane.tsx:205,212` — move the working-start state machine out of render into a `useState<number|null>` + an effect keyed on `[isWorking]` (rising/falling edge); guard the `<WorkingIndicator>` mount on `workingStartAt != null`. *(small)*
- `plugins/debug/plugins/health-monitor/web/components/health-monitor-panel.tsx:261` — capture `now` per-poll (`useMemo(() => Date.now(), [series])`) and thread it into `BackendRow` as a prop.
- `plugins/debug/plugins/live-state-churn/plugins/emit/web/components/emit-pane.tsx:239` — prop-lift a 1 Hz `nowMs` for the countdown; or, since it's a debug-only pane, `"use no memo"` on `StatusView` with a justifying comment. *(small)*

### 1d. Render-phase mutation → hoist / re-fetch (`immutability`, 2 files)
- `plugins/layouts/plugins/miller/web/hooks/use-column-maximize.ts:65` — in `toggle`, re-fetch `const next = stateFor(store)` before mutating (mirror the existing `useClearMaximize` precedent in the same file) instead of mutating the render-captured `s`.
- `plugins/page/plugins/read-only-view/web/components/read-only-blocks.tsx:375` — hoist the ordinal accumulator into a pure pre-pass loop producing an `ordinals[]` array; the JSX `.map` only reads it (no reassignment in the closure).

### 1e. `useMemo`-as-side-effect → `useEffect` or render-sync helper (`void-use-memo`, 5 sites / 4 files)
- `plugins/apps/plugins/surface/web/components/surface-body.tsx:63` — genuine post-commit side effect (`registerPlacementCapabilities` mutates a module store + notifies subscribers): convert `useMemo`→`useEffect`, same body and `[sorted, defaultId]` deps. *(not a render-phase-sync — `useEffect` is correct here)*
- **Router render-phase-sync cluster** (must run synchronously *during* render before `useRoute()` resolves on the same pass — `useEffect` would be a correctness bug):
  - `plugins/apps/web/components/apps-layout.tsx:143` — `setBasePath(basePath)` preamble.
  - `plugins/layouts/plugins/miller/web/components/pane-overlay-host.tsx:29` — identical `setBasePath` preamble.
  - `plugins/primitives/plugins/pane/web/pane.ts:1448` (`usePaneRoute`) — `store.setBasePath(basePath)`.
  - `plugins/primitives/plugins/pane/web/pane.ts:1321` (`useSyncPaneRegistry`) — rebuild `registry` + `store.handleLocationChange()`.

  **Recommended (structural):** introduce a tiny `useRenderSync(fn, deps)` helper — a
  ref-guarded "run `fn` during render when `deps` change" primitive carrying **one** internal
  `// eslint-disable-next-line react-hooks/refs` for its own guard. Replace all four
  `useMemo`-returning-void sites with `useRenderSync(...)`; the `void-use-memo` bail then never
  fires at any call site, the intent is named, and the lint exemption is localized to one file.
  Additionally investigate whether the `apps-layout` / `pane-overlay-host` `setBasePath`
  preambles are **redundant** with `usePaneRoute`'s own `setBasePath` (pane.ts:1448) — if so,
  delete them (the right structural dedup) rather than wrapping them.
  **Fallback (lower-risk, no new primitive):** per-site `useRef` guard
  (`if (last.current !== basePath) { last.current = basePath; setBasePath(basePath); }`) for
  the three `setBasePath` sites, and an inline `// eslint-disable-next-line react-hooks/void-use-memo -- intentional deps-gated render-phase sync; useEffect would resolve against a stale registry` for the two `pane.ts` sites.
  `pane.ts` is **load-bearing** (every layout renderer runs these per render) — validate with
  the boot + render-profiler G3 protocol (below) whichever path is taken.

### 1f. Genuine exempt — library incompatibility (`incompatible-library`, 1 file)
- `plugins/primitives/plugins/virtual-rows/web/internal/virtual-rows.tsx:147` — `@tanstack/react-virtual`'s `useVirtualizer` returns a mutable instance whose state mutates outside render; it cannot be compiled. Add `"use no memo";` as the first statement of **`useVirtualRows`** (the hook, not the `VirtualRows` component — the hook is consumed directly by data-table/data-view/tree too), with a comment citing `incompatible-library`. Runtime behavior is unchanged (the hook already manages its own memoization).

### 1g. Iterate to zero, then ratchet
1. `./equin build` (regenerates + rebuilds; runs `bun install`).
2. Re-scan: `bunx eslint "plugins/**/web/**/*.{ts,tsx}" -f json`. Fixing a component can
   surface a previously-masked sibling bail (e.g. `field-search-list.tsx`) — **fix any newly
   surfaced blocking violations and repeat** until the 7 bail-causing rules report **0**.
3. **Ratchet.** In `build-lint-config.ts`, after the `...compilerDiagnosticRulesAsWarn()`
   spread (line ~174) and alongside the existing `rules-of-hooks` / `exhaustive-deps` `"error"`
   pins, add explicit `"error"` pins (the spread forces `"warn"`; later explicit keys win):
   ```ts
   "react-hooks/purity": "error",
   "react-hooks/immutability": "error",
   "react-hooks/use-memo": "error",
   "react-hooks/void-use-memo": "error",
   "react-hooks/static-components": "error",
   "react-hooks/preserve-manual-memoization": "error",
   "react-hooks/incompatible-library": "error",
   ```
   (Mirror the existing two-pin precedent; optionally collect these into a `RATCHETED_TO_ERROR`
   array for clarity.) `./equin check`'s eslint now **fails** on any new bail of these
   rules — coverage is locked in. Leave `refs` / `set-state-in-effect` at `"warn"` until Phases
   2–3.

**Phase 1 effort:** ~½–1 day. Outcome: every web component compiles; 7 rules enforced at error.

---

## Phase 2 — `refs` burndown (180, 54 files)

Characterization (3 sampling agents over 31 sites): the violations are **mostly idiomatic,
not bugs** — the compiler still compiles these components.

| Pattern | ~Share | Bucket | Action |
|---|---|---|---|
| Latest-value ref (`const r = useRef(x); r.current = x`, read only in callbacks/effects) | ~50–70% | benign | Migrate to a new **`useLatestRef(value)`** primitive (one internal disable); call sites become clean |
| dnd-kit `setNodeRef` / `isOver` (library-managed) | ~33% (shard B) | exempt | Thin adapter hook around `useDroppable`/`useDraggable` with one disable, or per-site `// eslint-disable-next-line react-hooks/refs -- dnd-kit library ref` |
| Lazy-init ref, render-sync state reset, mount-only-effect capture | ~remainder | benign | Per-site `// eslint-disable-next-line react-hooks/refs -- <reason>`; optionally migrate immutable lazy-inits to `useState(() => …)` |
| **Genuine anti-patterns** (mutable-tracking ref read+written same render; DOM `getBoundingClientRect` in render; `ref.current` read inside `useMemo`/`.map`) | ~5 sites | refactor | Real fixes: `use-tab-presence.ts:60`, `tab-drag-overlay.tsx:38`, `block-editor.tsx:843`, `dnd-list-middleware.tsx:420`, `jsonl-pane.tsx:201` |

**Strategy:** (1) land `useLatestRef` in a small new leaf primitive
(`plugins/primitives/plugins/latest-ref/web`) and migrate the latest-value sites; (2)
exempt the dnd-kit sites (adapter or documented disable); (3) fix the ~5 real anti-patterns;
(4) document the remaining benign sites; (5) ratchet `react-hooks/refs` to `"error"`.
*(Long-term: React 19 `useEffectEvent` is the eventual structural replacement for the
latest-value idiom — note but defer.)*

**Effort:** ~1–2 days repo-wide (mostly mechanical, ~5 real refactors).

---

## Phase 3 — `set-state-in-effect` burndown (67, 56 files)

Characterization (2 sampling agents over 17 sites):

| Pattern | ~Share | Bucket | Action |
|---|---|---|---|
| props-to-state reset / mirror | ~30% | refactor | `key={prop}` remount for resets; drop the local mirror and read the prop directly |
| async-fetch result after `await` (with cancel flag) | ~35% | benign/migrate | Correct; prefer migrating to `useEndpoint`/`useResource`, else documented disable |
| external-store subscription, optimistic-cleanup, accumulated-set | ~remainder | benign | Document with inline disable; optionally migrate matchMedia → `useSyncExternalStore`, optimistic → `useOptimisticResource` |
| default-selection-on-load, first-item default | ~15% | refactor | Derive effective selection during render (`list.find(...) ?? list[0]`); store only explicit user selection |
| animation / temporal state machine | ~10% | exempt | `"use no memo"` (or `useReducer`) — these are structurally stateful |

**Strategy:** refactor the props-to-state and default-selection sites first (the real wins
that also remove state the compiler would otherwise have to track), migrate async-fetch to
`useEndpoint` where practical, document/`"use no memo"` the genuinely benign/stateful ones,
then ratchet `react-hooks/set-state-in-effect` to `"error"`.

**Effort:** ~1 day repo-wide.

---

## Critical files

- `plugins/framework/plugins/tooling/plugins/lint/core/build-lint-config.ts` — the ratchet edits (add `"error"` pins per phase, lines ~174–176).
- The 19 Phase-1 blocking files listed in §1a–1f.
- **New (Phase 1, optional structural):** `useRenderSync(fn, deps)` helper — home: `plugins/primitives/plugins/pane/web` (where 3 of 4 sites live) or a tiny leaf primitive.
- **New (Phase 2):** `plugins/primitives/plugins/latest-ref/web` — `useLatestRef(value)`.
- Reference for verification: `plugins/debug/plugins/render-profiler/web/internal/fiber-walk.ts` (G3 — component naming must survive).

---

## Verification (per phase)

1. **Scan delta:** `bunx eslint "plugins/**/web/**/*.{ts,tsx}" -f json` → confirm the phase's
   target rule(s) now report **0** (aggregate by `ruleId`).
2. **Check green:** `./equin check` (type-check + eslint) — must pass *after* the ratchet
   (proves the ratcheted rules are truly at 0).
3. **DOM tests:** `bun run test:dom` — green (85/85 baseline).
4. **Build:** `./equin build` — succeeds; app boots at `http://<worktree>.localhost:9000`.
5. **Compiler correctness (G3):** bundle still contains `react/compiler-runtime`; the
   render-profiler still names real components (not `Memo`/`Unknown`); `remounts === 0`. Spot-
   check the load-bearing fixes (`useResource`, `useCombinedResources`, the pane router) by
   opening a conversation page and confirming live-state updates and pane navigation behave
   identically. For the router cluster, deep-link load + app-switch must resolve panes correctly
   (no blank first frame / "Unknown pane").
6. **Hot-path spot fixes:** verify `jsonl-pane` "Working for Xs" counter, `field-picker` icon,
   `use-column-maximize` toggle, and the active-data inline chip render unchanged.

---

## Out of scope / follow-ups

- The **242 non-compiler warnings** (`@typescript-eslint/no-unnecessary-condition` 163, unused
  eslint-disable directives 79) — unrelated to the compiler; a separate lint-cleanup pass.
- **React 19 `useEffectEvent`** migration to structurally retire the latest-value-ref idiom.
- Folding the `setBasePath` preamble entirely into `usePaneRoute` (router dedup) if §1e finds
  the caller preambles redundant.
- The adoption doc's open **G2** (controlled render-cost A/B on a conversation-page cascade).

---

## Risks

1. **Sibling bails surface after fixes** (e.g. `field-search-list`). Mitigated by the
   iterate-to-zero re-scan loop before any ratchet.
2. **Load-bearing primitives** (`use-resource`, `resource-utils`, `pane`). Fixes are local and
   identity-preserving, but a regression is broad — gated by the G3 protocol + manual spot-checks.
3. **Ratcheting too early** turns `./equin check` red. Only ratchet a rule when its scan
   count is 0; ratchet bail-rules in Phase 1, `refs`/`set-state` only after their burndowns.
4. **`useRenderSync` on the router** — if it doesn't fully clear the caller bails, fall back to
   the per-site ref-guard + inline disable (agent-verified for `apps-layout`/`pane-overlay-host`).
5. **`"use no memo"` scope** — applied to `useVirtualRows` (the hook), not consumers, so every
   downstream call site stays individually compiled.
