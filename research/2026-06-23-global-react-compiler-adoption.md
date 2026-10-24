# React Compiler Adoption — Evaluation & De-risked Rollout

**Date:** 2026-06-23
**Category:** global (frontend build infrastructure)
**Status:** Plan — evaluate-then-decide, gated on measured coverage + render-cost

---

## Context

Idle/no-op live-state pushes re-render large subtrees several times a second. The
**per-render-cost** class of churn — a re-render allocating a fresh-but-equal JSX
element that defeats a child's memo, or an unstable context value re-rendering all
consumers — is currently mitigated **by hand, one subtree at a time**:

- `22e85e1f6` (markdown): `useMemo` on the `<ReactMarkdownLib>` element tree.
- `eab8c0e55` (diff-view): `React.memo` on `DiffRenderer` + `useMemo` on the `<Diff>` element array.
- `3cd71c05c` (reorder): removed redundant ref-wrapping arrows feeding a `Context.Provider` value.

Each fix is per-component discipline that the next un-memoized subtree re-opens, and the
hand-maintained dep arrays are a staleness-bug surface. The codebase carries ~654 `useMemo`
+ ~475 `useCallback` call sites across ~260 web files doing exactly this work manually.

**React Compiler 1.0** (GA Oct 2025) auto-inserts this memoization uniformly, with correct
deps by construction — eliminating the per-subtree treadmill for patterns 1 and 2. The repo
is compiler-ready: React 19.1 (native, no runtime polyfill), `@vitejs/plugin-react@^4.4.1`
(Babel-based), a generic per-plugin `vite/` Babel-contribution seam, and `esbuild.keepNames`
already set so the render-profiler reads real component names off fibers.

**Intended outcome:** structurally eliminate the per-render-cost churn class across all
~540 plugins, retiring the manual-memo treadmill — **if** measured coverage and render-cost
gains justify it. This plan lands the compiler in the worktree, measures it, and defines the
adopt-vs-not decision gate. The compiler does **not** cover element-type/remount churn
(stays lint-guarded) nor server-side no-op-push frequency.

---

## Scope of what the compiler covers (and does not)

| Churn class | Covered? | Guard |
|---|---|---|
| Fresh-but-equal JSX defeating a child memo (pattern 1) | ✅ compiler | — |
| Unstable context value re-rendering all consumers (pattern 2) | ✅ compiler | `no-unstable-context-value` stays (defense-in-depth) |
| Post-mount element-type swap → forced remount | ❌ | `no-post-mount-element-type` lint rule — **KEEP** |
| Server-side no-op-push frequency | ❌ (client-render-cost only) | `live-state-churn/monitor` |

---

## Decisions taken (this conversation)

- **ESLint rollout: warn-first, then ratchet.** Compiler diagnostic rules added at `"warn"`
  so `./equin check` stays green; the warning count is the silent-bail/coverage metric.
- **Gating: structural only, no env flag.** The new `vite/` plugin's *presence* is the
  on/off switch. The evaluation happens in this worktree; rollback = delete the folder (or
  don't push). No flag branch in the factory.
- **`compilationMode: 'infer'`** (the compiler's *default*). This compiles every function
  inferred to be a component or hook (PascalCase / `use*`), uniformly across all plugins —
  which IS the "compile everything" goal. Annotation/opt-in would defeat the purpose; the
  compiler respects existing manual memoization via `preserve-manual-memoization`.
  > **Not `'all'`.** During implementation, `'all'` was found to crash boot: it also compiles
  > plain top-level helpers (e.g. `defineCollectedDir`), injecting `useMemoCache` into
  > functions that run at module-eval where React's dispatcher is null →
  > `Cannot read properties of null (reading 'useMemoCache')`. `'infer'` is the correct mode.

---

## Part 1 — Enable the compiler as a plugin (not a core edit)

**New leaf plugin** under the build-time-tooling umbrella:

```
plugins/framework/plugins/tooling/plugins/react-compiler/
  CLAUDE.md
  vite/index.ts        <- the only functional file; default-exports the factory
```

Placement rationale: `framework/tooling` is the declared umbrella for build-time tooling
(boundary checker, lint, checks, codegen). A Babel transform belongs here — not under
`improve` (a product feature) nor inside `web-core` (bootstrap-only). Following the existing
"presence of `vite/` == presence of the transform" idiom, deleting this folder is the
complete structural off-switch (byte-identical to today).

**`vite/index.ts` contract** — must mirror the one existing contributor
(`plugins/improve/plugins/element-picker/vite/index.ts`): a single **self-contained** file,
only `node:*` imports (no `@plugins/*`, no `@babel/*`, no sibling `.ts`), because
`vite.config.ts` loads it via runtime `import()` of its absolute path.

- **Resolve the compiler by absolute path at factory-call time**, do not bare-import it.
  web-core is ESM (`"type": "module"`), so use `node:module`'s
  `createRequire(import.meta.url)` then `require.resolve("babel-plugin-react-compiler")`,
  and hand Babel the resolved path string. `node:module` satisfies the self-contained
  constraint and resolves from the repo `node_modules` regardless of the dynamic-import entry.
- Returns `{ order: -100, plugin: [resolvedPath, { target: '19', compilationMode: 'all' }] }`
  (the ordered shape — see Part 2). `target: '19'` ⇒ no `react-compiler-runtime` polyfill.

**Dependency:** add `babel-plugin-react-compiler` (latest, exact pin) as a devDependency.
It is **not yet installed**. Put it in the new plugin's `package.json` (plugin-local dep,
per repo convention) and/or root devDependencies; `./equin build` runs `bun install`.

---

## Part 2 — Solve Babel-plugin ordering structurally

React requires the compiler to run **first** in the Babel plugin list. Today
`findViteContributions` pushes contributions in **filesystem order** with no control, and
there is already one contributor (element-picker). Fix generically — **no naming of
contributors** (collection-consumer separation).

**Design:** add an optional numeric `order` to the contribution contract; stable-sort
ascending (lower = runs first).

### Edits

**A. `plugins/framework/plugins/web-core/vite.config.ts`** (lines ~31–75)
- Accept either a bare `BabelPluginItem` (back-compat, normalizes to `order: 0`) **or**
  `{ order?: number; plugin: BabelPluginItem }` from each contributor's default export.
- In the collection loop (lines ~66–71): collect `{ order, plugin }` records, then
  **stable-sort by `order`** before mapping into `babelPlugins`. Reserve `order: -100`
  for "must run first" (the compiler).
- Discovery walk itself unchanged — only collection/normalization/sort added. Consumer
  still reads a generic field, never names a contributor. Document the `order` convention
  in a comment.

**B. `plugins/improve/plugins/element-picker/vite/index.ts`**
- Left functionally **unchanged**: a bare return normalizes to `order: 0`, so it lands
  after the compiler. (Optionally wrap as `{ order: 0, plugin }` for self-documentation —
  one line, no transform-logic change.)

**C. `plugins/framework/plugins/tooling/plugins/react-compiler/vite/index.ts`**
- Returns `{ order: -100, plugin: [...] }`.

**Gate G0 (contract):** a build shows the compiler plugin emitted first; element-picker's
`data-source` / `data-ui-owner` stamping still present in built DOM (pick-test in the app).

---

## Part 3 — ESLint Rules-of-React (warn-first, then ratchet)

The compiler **silently bails** on Rules-of-React violators (they compile to pass-throughs
with no memoization). The eslint rules are the **only** way to find/count those — this is the
core coverage signal.

**Where:** `plugins/framework/plugins/tooling/plugins/lint/core/build-lint-config.ts`, in
`baseConfigs[0].rules` (lines ~117–132), alongside the existing hand-written
`react-hooks/rules-of-hooks` + `react-hooks/exhaustive-deps`. Do **not** route through the
contributed-plugin path (lines ~150–156) — that force-promotes to `"error"`, which we want
to avoid during evaluation.

**How:** the diagnostics ship in `reactHooks.configs['recommended-latest']` (the standalone
`eslint-plugin-react-compiler` is deprecated). Spread its rules into the base config, then
**override severities**:
- Keep `rules-of-hooks` + `exhaustive-deps` at `"error"` (unchanged).
- Set the newly-introduced compiler rules (config, error-boundaries, gating, globals,
  immutability, `preserve-manual-memoization`, purity, refs, set-state-in-effect,
  set-state-in-render, static-components, unsupported-syntax, use-memo, incompatible-library)
  to `"warn"`.
- Keep `preserve-manual-memoization` effectively load-bearing — it protects the existing
  ~654 `useMemo`/~475 `useCallback` from compiler/manual conflict; promote to `"error"` early
  if its warn-count is ~0.

**Triage / measure:** run `bunx eslint` over the web tree; **count warnings by rule and by
plugin**. This is the silent-bail surface; coverage ≈ inverse of violation density. Feeds
gate G1. Ratchet near-zero rules to `"error"`; leave high-count rules as a cleanup backlog.

**Keep both existing lint guards** (compiler does not subsume them):
- `element-type-safety/no-post-mount-element-type` — remount/reconciliation, not render-freq.
- `context-safety/no-unstable-context-value` — defense-in-depth (compiler can bail per-component).

---

## Part 4 — Verification & measurement protocol

All measurement runs on a **settled idle conversation page** (let live-state quiesce first).
Resource keys come from `GET /api/resources/_debug`. Baseline = compiler folder absent;
candidate = compiler folder present. (No env flag — add/remove the `vite/` plugin, or use
two builds.)

**Render-cost (core metric), for baseline and candidate:**
1. Open conversation page; wait until idle (no commits).
2. `window.__reactRenderProfiler.start({ maxDurationMs: 10000 })`
3. `window.__liveStateEmit.start({ key: <resource>, rate: 20, durationMs: 8000 })` — synthetic
   no-op (empty-diff) pushes through the real server→WS→client→React path at a fixed rate.
4. `window.__reactRenderProfiler.stop()` then `.getReport()`.
5. Record `totalCommits`, `commitsPerSec`, top `initiators[]`, `remounts[]`.
6. Headless repro: `bun e2e/render-profile.mjs --url http://<wt>.localhost:9000/<route> --seconds 8`
   while the emitter runs.

Compare at **identical push rate**: candidate should show **lower-or-equal `commitsPerSec`**
and fewer/cheaper initiators. `remounts[]` must be **unchanged** (compiler doesn't touch
reconciliation — a change here is a red flag, not a win).

**Profiler still names components (correctness guard):** after the candidate build,
`.getReport()` initiators must still show real names (e.g. `DiffRenderer`, not `Memo` /
`Unknown#N`). `getComponentName` (`plugins/debug/plugins/render-profiler/web/internal/fiber-walk.ts`
lines ~26–45) unwraps memo HOCs (`type.type ?? type`) and `keepNames` preserves
`function.name`, so names should survive. Hook **index** numbers may shift (compiler-inserted
hooks) — display-only, **not** a gate failure.

**Tests / checks / build:**
- `bun run test:dom` (vitest/jsdom; discovers `plugins/**/web/__tests__/**`) — green.
- `bun test <path>` for representative pure-logic suites — green.
- `./equin check` (type-check + eslint) — green with compiler rules at `"warn"`.
- `./equin build` — succeeds with the plugin present.

---

## Part 5 — Decision gates (adopt vs not)

| Gate | Adopt if | Block if |
|---|---|---|
| **G0** contract | compiler emitted first; element-picker stamping intact | ordering wrong or stamping lost |
| **G1** coverage | clean-component share high (target ≥ ~80% of web components compile) | violation surface so large most components bail |
| **G2** render-cost | candidate `commitsPerSec` ≤ baseline at fixed rate, measurable drop on known-hot initiators | commitsPerSec or remounts **increase** |
| **G3** correctness | profiler still names components; remounts unchanged; test:dom + check + build green | any test red, build fail, or attribution broken |
| **G4** effort | remaining warn-cleanup backlog is bounded/triageable | cleanup cost exceeds measured win |

**Adopt only if G0–G3 pass and G4 is acceptable.** If not, delete the plugin folder
(structural revert) — nothing shipped. If adopting, ratchet eslint per Part 3 and note the
hook-index-drift caveat in the render-profiler `CLAUDE.md`.

---

## Risks & open questions

1. **Low coverage is the headline risk.** If the warn count is large across ~540 plugins,
   most components silently bail and the compiler buys little while adding build cost + a
   memo-HOC layer. G1 kills the project early if so. Most likely "not worth it" outcome.
2. **`@vitejs/plugin-react` v6 drops Babel.** We're on `^4.4.1` (fine). A future v6 bump
   would require migrating the compiler (and the whole `findViteContributions` Babel seam,
   incl. element-picker) off Babel to the oxc/swc path. Out of scope; flag before any
   plugin-react major bump.
3. **`keepNames` + compiler interaction.** Memo-HOC wrapping could shift which function
   carries `.name`. Mitigation exists (unwrap path); G3 confirms on real built+minified output.
4. **Hook-index attribution drift** in the profiler (compiler-inserted hooks). Display-only;
   slightly blunts the profiler post-adoption. Acceptable.
5. **Stricter purity/immutability rules** may surface code that currently passes the narrower
   two-rule set. Warn-first absorbs this; triage feeds the backlog.
6. **element-picker after the compiler** — confirm `data-source`/`data-ui-owner` still stamp
   the right host elements after the compiler restructures component bodies (G0 pick-test).
7. **Server-side push frequency is unaffected** — if real churn is server-driven (what
   `live-state-churn/monitor` detects), the compiler is the wrong lever. The emitter
   measurement reveals whether render cost or push frequency dominates.

---

## Critical files

- `plugins/framework/plugins/web-core/vite.config.ts` — ordering contract + stable sort (lines ~31–75).
- `plugins/framework/plugins/tooling/plugins/react-compiler/vite/index.ts` — **NEW**; self-contained, `createRequire` resolution, `order: -100`, `compilationMode: 'infer'`.
- `plugins/framework/plugins/tooling/plugins/react-compiler/{CLAUDE.md,package.json}` — **NEW**; plugin doc + `babel-plugin-react-compiler` dep.
- `plugins/framework/plugins/tooling/plugins/lint/core/build-lint-config.ts` — compiler diagnostic rules, warn-first (base rules lines ~117–132).
- `plugins/improve/plugins/element-picker/vite/index.ts` — existing contributor; stays at default `order: 0`.
- `plugins/debug/plugins/render-profiler/web/internal/fiber-walk.ts` — verification reference (G3).

---

## Results (implemented & measured 2026-06-23)

The plan was implemented and the gates evaluated on a live build at
`http://att-1782215650-fcgc.localhost:9000`. Installed: `babel-plugin-react-compiler@1.0.0`,
React `19.2.5` (native runtime, no polyfill).

### Gate outcomes

| Gate | Result | Evidence |
|---|---|---|
| **G0** contract | ✅ PASS | Compiler emitted first (`order: -100` sorts before element-picker's `order: 0`); bundle contains `react/compiler-runtime` + `useMemoCache`; element-picker `data-source` survives in 331 files. |
| **G1** coverage | ✅ PASS (strong) | `bunx eslint` over 2153 web files: **90.2% have zero compiler warnings** (211 files / 9.8% warn); **0 errors**. Bail-causing rules tiny: `incompatible-library` 1, `purity` 5, `immutability` 2, `use-memo` 3, `static-components` 3. Noise concentrated in `refs` (180) + `set-state-in-effect` (67), which rarely block compilation. |
| **G2** render-cost | ⚠️ INCONCLUSIVE | See below — the `/agents` config-churn probe is too noisy to isolate the compiler effect. |
| **G3** correctness | ✅ PASS | App boots; profiler still names real components (`GroupStyle`, `LaunchControl`, `ReorderListMiddlewareInner`, `CategoryAvatarRow` — not `Memo`/`Unknown`); remounts = 0 both builds; `bun run test:dom` 85/85 pass; `./equin check` green (warn-first); build succeeds. |
| **G4** effort | ✅ acceptable | 512 total warnings, mostly low-stakes `refs`/`set-state-in-effect`; bounded triage backlog. |

### G2 measurement — why it's inconclusive

Probe: load `/agents`, auto-pick the highest-subscriber resource (`config-v2.values`,
80 subscribers), drive 20 synthetic no-op pushes/s via `__liveStateEmit`, record commits/s
via `__reactRenderProfiler`. DOM mutations were **0** throughout (pure wasted re-renders).

Observed `commitsPerSec`:
- First pass — OFF: 159 / 171 / 172; ON: 105 / 121. Suggested a ~32% reduction.
- Second pass (back-to-back, **same** ON build): 176 / 177 / 268 / 241 / 229.

The run-to-run variance on a single build (105 → 268) **exceeds** any ON/OFF delta, so the
apparent reduction is within noise. Root cause: the dominant churn is `GroupStyle`, a *direct*
`config-v2.values` subscriber (~80–90 commits/s) — that is legitimate subscription churn the
compiler does **not** target (the compiler eliminates parent→memoized-**child** cascades, not
a real subscription firing). Plus each fresh headless load settles into a slightly different
mounted tree (e.g. a `TaskDraftPopover` open or not), changing the subscriber fan-out.

**Remaining work for a clean G2:** probe a *settled idle conversation page* churned by its own
conversation resource (`conversation-progress` / `turn-summaries`), where the original
motivating fixes (markdown / diff-view) live — a true parent→child cascade — and run a
controlled A/B (compiler OFF rebuild via the structural off-switch) with many iterations per
side. This is the one open gate before a final adopt decision.

### Lessons folded back into the implementation

- **`compilationMode` must be `"infer"` (default), NOT `"all"`.** `"all"` compiles plain
  top-level helpers (`defineCollectedDir`), injecting `useMemoCache` into functions that run
  at module-eval where React's dispatcher is null → hard boot crash
  (`Cannot read properties of null (reading 'useMemoCache')`). Fixed; documented in the
  plugin's `vite/index.ts` + `CLAUDE.md` with a "do not switch to all" warning.
- **Boot is slow headless** (3MB bundle + ~540 plugins): the stock `e2e/*.mjs` 3s wait is too
  short to find `__liveStateEmit`/`__reactRenderProfiler`; poll for the globals instead.
- **`useMemoCache` as a bundle string is not an OFF signal** (react-dom defines it on its
  dispatcher). Use `react/compiler-runtime` presence to confirm the compiler ran.

### Net recommendation

Structurally **green to adopt**: high coverage, correct, tests/checks pass, clean rollback
(delete the plugin folder). The single missing piece is a *controlled* render-cost
measurement on a conversation-page cascade to quantify the actual win — recommend running
that A/B before flipping this from "evaluation in worktree" to "merged".
