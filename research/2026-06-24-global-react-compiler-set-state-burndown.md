# React Compiler Compliance — `set-state-in-effect` burndown & ratchet to error

**Date:** 2026-06-24
**Category:** global (frontend / build infrastructure)
**Status:** Plan — ready to execute
**Follows:** [`2026-06-23-global-react-compiler-compliance.md`](./2026-06-23-global-react-compiler-compliance.md) (Phase 3) · Phases 1 (coverage) & 2 (`refs`) already landed.

---

## Context

The React Compiler is enabled repo-wide (`compilationMode: "infer"`). Its Rules-of-React
eslint rules ship at `"warn"` and are ratcheted to `"error"` one at a time as each rule's
warning count is driven to zero — that ratchet is what locks in compiler coverage (a new
violation then fails `./equin check` instead of silently eroding it).

Phases 1 and 2 are **done**: a fresh scan (`bunx eslint "plugins/**/web/**/*.{ts,tsx}"`,
2026-06-24) confirms **every react-hooks rule reports 0 except one**:

```
68  react-hooks/set-state-in-effect   ← the last rule still at "warn"
 0  (all others: refs, purity, immutability, use-memo, void-use-memo,
     static-components, preserve-manual-memoization, incompatible-library)
```

`set-state-in-effect` flags a state setter called inside `useEffect`. The compiler still
**compiles** these (correctness/style only, not a coverage bail), which is why it was left
for last. **68 sites across 57 files.** This plan refactors the genuine anti-patterns,
migrates the legitimate-but-flagged effects onto existing primitives where clean, documents
the genuinely-stateful remainder with inline exemptions, then ratchets the rule to `"error"`.

**Intended outcome:** scan reports `set-state-in-effect: 0`, `./equin check` is green,
the rule is pinned at `"error"` — making it the last react-hooks rule enforced, completing
the React Compiler compliance program.

Every site was individually characterized (read in context) by a 14-agent fan-out; the
per-site bucket, recommended fix, effort, and load-bearing flag below come from that pass
and were spot-validated against the load-bearing files directly.

---

## Distribution (all 68 sites)

| Wave | Action | Sites | Touches |
|---|---|---|---|
| **A** | Derive in render (delete state+effect, compute during render) | 11 | client only |
| **B** | `key=` remount (let `useState` re-init naturally on identity change) | 11 | parent / self-key |
| **C** | Migrate to `useEndpoint` (endpoints already exist) | 13 | **client only** |
| **D** | Migrate to `useSyncExternalStore` | 3 | client only |
| **E1** | Extract `useHighlightedHtml` Shiki primitive, fold 4 dup effects into it | 4→1 | new leaf hook |
| **E2** | Documented inline-disable (genuinely-stateful) + 2 small refactors | 26 | in-place |

Net exemptions after the burndown: **~25 documented inline-disables + 1 inside the new
Shiki hook** — every one a compiler-still-compiles effect with a stated reason. Everything
else is refactored or migrated.

---

## Exemption mechanism (read first)

`set-state-in-effect` is a **compile-OK** rule, so the only exemption tool is the inline
disable (never `"use no memo"` — that's reserved for `incompatible-library`). Mirror the
exact Phase-2 wording convention (`build-lint-config.ts:197`, and the landed `refs`
disables):

```ts
// eslint-disable-next-line react-hooks/set-state-in-effect -- <idiom name>: <why the effect is correct> ; <why derive-in-render / a primitive is impossible here>
```

The reason must name the idiom ("optimistic-cleanup", "animation-temporal-machine",
"async-fetch with cancel guard", "gate first-settle transition") **and** state why moving
it out of an effect would be wrong. For a block of consecutive disables in one function, use
the file-block form (`/* eslint-disable react-hooks/set-state-in-effect -- … */ … /* eslint-enable */`),
as `pane/web/use-render-sync.ts` does for `refs`.

---

## Wave A — Derive in render (11)

Delete the `useState`+`useEffect`; compute the value during render. Two sub-patterns:
**default-selection** → `const effective = explicitChoice ?? list[0]?.id ?? null` (keep state
only for the user's explicit pick); **derived-recompute** → `useMemo`/inline clamp, or
co-locate the reset inside the existing event callback (the slash/inline-menu cases reset
`activeIndex` right where `setQuery` already fires, not a render later).

| Site | Symbol | Bucket | Effort |
|---|---|---|---|
| `plugins/apps/plugins/sonata/plugins/shell/web/context.tsx:344` | SonataProvider | default-selection | small · **LB** |
| `plugins/apps/plugins/sonata/plugins/shell/web/context.tsx:634` | SonataProvider | derived-recompute (clamp `spread`) | small · **LB** |
| `plugins/apps/plugins/studio/plugins/compositions/web/components/compositions-view.tsx:233` | CompositionsView | derived-recompute (`editingId = active ? editingId : null`) | trivial |
| `plugins/code-explorer/web/components/file-tree.tsx:143` | FileTree | derived-recompute (ancestors of selection) | small |
| `plugins/conversations/plugins/conversation-view/plugins/code/plugins/docs-button/web/components/docs-pane.tsx:82` | DocsPaneBody | default-selection | small |
| `plugins/history/plugins/dialog/web/components/version-history-dialog.tsx:104` | VersionHistoryDialog | default-selection | small |
| `plugins/page/plugins/editor/web/components/slash-menu-plugin.tsx:136` | SlashMenuPlugin | derived-recompute (`activeIndex`) | small |
| `plugins/page/plugins/inline-date/web/components/inline-date-plugin.tsx:117` | InlineDatePlugin | derived-recompute (`activeIndex`) | small |
| `plugins/page/plugins/inline-page-link/web/components/inline-page-link-plugin.tsx:110` | InlinePageLinkPlugin | default-selection (`activeIndex` clamp) | small |
| `plugins/search/plugins/quick-find/web/components/quick-find-dialog.tsx:71` | QuickFindDialog | default-selection (`activeIdx` clamp) | small |
| `plugins/tasks/plugins/task-draft-form/web/components/task-draft-popover.tsx:132` | TaskDraftFormContent | derived-recompute (`insertBeforeIds`) | medium |

- **`sonata/shell/context.tsx:344,634` (LB):** derive `effectiveSourceId`/`effectiveSpread`
  and route every consumer through the derived value; audit all readers of `activeSourceId` /
  `spread` (loader keys, `setActiveSource` guards). Keep raw state for the user's explicit
  pick only.
- **`task-draft-popover.tsx:132` (medium):** must preserve "reset user toggles when the
  children list changes" — derive the default `Set` from `relateTaskChildren` but keep a
  user-override layer (or re-key the controlled child). Don't lose the reset semantic.

---

## Wave B — `key=` remount (11)

These mirror/reset props into state. Drop the mirror; let `useState` re-initialize by
remounting. **Default to a self-keyed inner component for shared primitives** (co-locate the
remount so no consumer can forget the key); use a parent `key=` only for single-consumer
components. Precedents: `task-detail/web/panes.tsx:60` (`key={taskId}`), `agents/web/panes.tsx:86`
(`key={id}`), `terminal-pane-body.tsx:39` (counter-keyed imperative remount).

| Site | Symbol | Key on | Effort |
|---|---|---|---|
| `plugins/apps/plugins/browser/plugins/omnibox/web/components/omnibox.tsx:18` | Omnibox | `current` URL (parent) | small |
| `plugins/code-explorer/web/components/file-tree-view.tsx:23` | FileTreeView | `worktree` (parent) | small |
| `plugins/config_v2/plugins/settings/web/components/config-detail.tsx:70` | ConfigDetailInner | `registration.storePath` (same file) | trivial |
| `plugins/config_v2/plugins/settings/web/components/config-detail.tsx:128` | ConfigDetailBody | `storePath+':'+scopeId` (same file) | trivial |
| `plugins/conversations/plugins/agents/web/components/agent-detail.tsx:63` | AgentDetailInner | `agentId` (same file) | trivial |
| `plugins/debug/plugins/logs/web/components/log-viewer.tsx:99` | LogViewer | extract `LogChannelView key={selectedKey}` | medium |
| `plugins/primitives/plugins/command-palette/web/internal/command-palette-dialog.tsx:86` | CommandPaletteDialog | `open` (self-key dialog body) | small |
| `plugins/primitives/plugins/css/plugins/color-picker/web/internal/color-input.tsx:27` | ColorInput | `color+format` (from ColorPicker) | small |
| `plugins/primitives/plugins/diff-view/web/components/diff-view.tsx:294` | DiffView | self-keyed inner on `worktree:path:base:head:from` | small · **LB** |
| `plugins/primitives/plugins/folder-picker/web/internal/folder-picker-popover.tsx:32` | FolderPickerPopover | committed `value` (caller) | small |
| `plugins/search/plugins/quick-find/web/components/quick-find-dialog.tsx:62` | QuickFindDialog | `open` (self-key, same file as A's :71) | small |

- **`diff-view.tsx:294` (LB):** has many consumers — use the **self-keyed inner** pattern
  (`const k = [worktree,path,base,head,from].join(':'); <DiffBody key={k} … />`) so the
  remount is owned by the primitive, not spread across every call-site.
- **`log-viewer.tsx:99` (medium):** extract a `LogChannelView` child owning `entries` +
  WS/SSE subscriptions; parent renders `<LogChannelView key={selectedKey} … />`.
- **`quick-find-dialog.tsx`** has both a B (:62 reset-on-open) and an A (:71 `activeIdx`
  clamp) site — fix together; self-keying the body on `open` covers :62.

---

## Wave C — Migrate to `useEndpoint` (13, client-only)

Every one already calls `fetchEndpoint(<existing endpoint>)` inside a `useState`+`useEffect`+
cancel-flag. Swap for `useEndpoint(endpoint, params, { query, enabled })` from
`@plugins/infra/plugins/endpoints/web` — it returns `{ data, isLoading, error, refetch }`
(TanStack Query: built-in cancellation via `AbortSignal`, dedup, typed `EndpointError`).
Delete the bespoke `…State` unions and the effect. **No server changes** — the
`defineEndpoint` contracts already exist.

| Site | Symbol | Endpoint | Effort |
|---|---|---|---|
| `plugins/conversations/plugins/conversation-view/plugins/push-profiling/web/components/push-profiling-pane.tsx:39` | PushProfilingPaneBody | `getPushProfiling` | small |
| `plugins/debug/plugins/memory/web/components/memory-panel.tsx:55` | MemoryPanel | `listMemoryFiles` (+ derive default-select) | small |
| `plugins/debug/plugins/memory/web/components/memory-panel.tsx:58` | MemoryPanel | `readMemoryFile` (`enabled`) | small |
| `plugins/debug/plugins/profiling/plugins/boot/web/components/boot-section.tsx:206` | BootSection | `getBootProfiling` | small |
| `plugins/debug/plugins/profiling/plugins/build/web/components/build-detail.tsx:41` | BuildProfileDetailBody | `getBuildRunProfileByWorktree` | small |
| `plugins/debug/plugins/profiling/plugins/build/web/components/build-section.tsx:31` | BuildSection | `getBuildProfiling` | small |
| `plugins/debug/plugins/profiling/plugins/push/web/components/push-detail.tsx:102` | PushDetailBody | `getPushDetail` | small |
| `plugins/debug/plugins/profiling/plugins/push/web/components/push-section.tsx:31` | PushSection | `getPushProfiling` | small |
| `plugins/debug/plugins/profiling/plugins/stats/web/components/stats-section.tsx:43` | StatsSection | `getStatsProfiling` | small |
| `plugins/code-explorer/plugins/file-resolve/web/internal/use-resolved-file.ts:20` | useResolvedFile | code `resolve` | small |
| `plugins/conversations/plugins/conversation-view/plugins/code/plugins/file-pane/web/use-file-content.ts:18` | useFileContent | `getFileContent` | small · **LB** |
| `plugins/conversations/plugins/conversation-view/plugins/commits-graph/web/use-commit-files.ts:22` | useCommitFiles | `getCommitFiles` | small |
| `plugins/primitives/plugins/diff-view/web/use-file-diff.ts:21` | useFileDiff | `getFileDiff` | small · **LB** |

> Targeting `useEndpoint` (request/response), **not** `useResource` — this data is fetched
> on demand, not pushed over live-state, and no resource descriptors exist for it. Standing
> up live-state resources (server loader + descriptor + change triggers) would be a much
> larger change, unjustified for a lint burndown.

- **Profiling `refreshKey`:** the boot/build/push/stats sections refetch on a context
  `refreshKey`. Replace the manual reload with `useEndpoint(...)` and, on `refreshKey`
  change, call `q.refetch()` from a tiny effect — `refetch` is **not** a state setter, so
  that effect is clean (no `set-state-in-effect`).
- **`useFileContent` / `useFileDiff` (LB):** map `EndpointError` onto the existing
  `FileContentState`/`FileDiffState` shape if consumers depend on it; verify the
  loading-on-input-change behavior (a query-key change keeps prior data + `isFetching`) is
  acceptable, else keep an explicit reset.

---

## Wave D — Migrate to `useSyncExternalStore` (3)

External (DOM / module store) subscriptions read into state via an effect — the canonical
fix is `useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)`. Mirror
`reorder/web/internal/edit-mode-store.ts` (module `let` + `Set<() => void>` listeners).

| Site | Symbol | Source | Effort |
|---|---|---|---|
| `plugins/debug/plugins/boot-profile/web/components/boot-profile-live.tsx:23` | BootProfileLive | `subscribeBootTrace`/`getBootTrace` (already a store) | small |
| `plugins/primitives/plugins/css/plugins/ui-kit/web/hooks/use-mobile.ts:14` | useIsMobile | `matchMedia` | small · **LB** |
| `plugins/reorder/plugins/editor/web/internal/items.tsx:75` | SortableReorderItem | `MutationObserver` → extract `useIsEmpty(ref, enabled)` | small |

- **`use-mobile.ts` (LB, ⚠ shadcn-generated):** header says "Generated by the shadcn CLI —
  do not edit by hand." The file is committed and regeneration is rare/manual, so editing it
  in place is acceptable; the `useSyncExternalStore` rewrite also removes the initial
  `undefined` flicker the current `!!isMobile` cast masks. (If we'd rather not touch a
  generated file, a documented inline-disable is the fallback — but the rewrite is the clean
  choice and matches the chosen posture.)

---

## Wave E1 — Extract `useHighlightedHtml` Shiki primitive (4 → 1)

Four components run the identical async dance: `getHighlighter().then(…)` →
`setHtml(highlighted)` with a `cancelled` flag. Extract one hook in **`primitives/syntax-highlight/web`**:

```ts
// primitives/syntax-highlight/web/internal/use-highlighted-html.ts
export function useHighlightedHtml(code: string, lang: string, opts?: { dark?: boolean; line?: number }): string | null
// owns the getHighlighter + cancel-flag effect; carries the ONE documented
// `// eslint-disable-next-line react-hooks/set-state-in-effect -- async Shiki highlight; cancel guard prevents stale setState`
```

Consumers drop their state+effect and call the hook (`highlighted-code.tsx` already lives in
this plugin and becomes the hook's first consumer / home):

| Site | Symbol |
|---|---|
| `plugins/primitives/plugins/syntax-highlight/web/internal/highlighted-code.tsx:62` | HighlightedCode |
| `plugins/conversations/plugins/conversation-view/plugins/code/plugins/file-pane/plugins/raw/web/components/raw-view.tsx:53` | RawView |
| `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/code-listing/web/components/code-with-line-numbers.tsx:71` | CodeWithLineNumbers |
| `plugins/page/plugins/code-block/web/components/code-block.tsx:75` | CodeBlock |

> The diff-view Shiki sites produce **tokens**, not an html string (`text-diff.tsx:93`,
> `use-diff-tokens.ts:112`), a different return shape — they stay documented disables in E2.
> A future `useHighlightedTokens` sibling could fold them too; not in scope.

---

## Wave E2 — Documented inline-disables + 2 small refactors (26)

Genuinely-stateful effects the compiler compiles fine and no primitive owns. Add the inline
disable with the stated reason. Buckets: **animation/temporal machines**, **NDJSON
streaming / polling** (no streaming primitive), **async fan-out** (`Promise.all` over a
dynamic set), **optimistic-cleanup** (prop-fed rows — not live-state-backed, so
`useOptimisticResource` doesn't apply), **external DOM lifecycle**, **primitive internals**.

| Site | Symbol | Reason bucket | Effort |
|---|---|---|---|
| `plugins/apps/plugins/sonata/plugins/library/web/panes.tsx:84` | useSonataPlayerResolve | async fan-out over `Library.Source` registry | trivial |
| `plugins/apps/plugins/sonata/plugins/shell/web/context.tsx:393` | SonataProvider | transport reset on score change | trivial · **LB** |
| `plugins/apps/plugins/sonata/plugins/shell/web/context.tsx:646` | SonataProvider | freeze transport at 0% tempo | trivial · **LB** |
| `plugins/apps/plugins/surface/plugins/floating/web/hooks/use-window-motion.ts:226` | useFloatingWindowStyle | one-shot rAF transition arm | trivial |
| `plugins/apps/plugins/surface/plugins/floating/web/hooks/use-window-motion.ts:240` | useFloatingWindowStyle | minimize/restore animation phase machine | trivial |
| `plugins/conversations/plugins/conversation-view/plugins/code/plugins/docs-button/web/use-pushed-doc-files.ts:27` | usePushedDocFiles | async fan-out over push ids | trivial |
| `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/plugins/workflow/web/internal/use-workflow-trace.ts:24` | useWorkflowTrace | async client-side trace exec | trivial |
| `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web/components/jsonl-pane.tsx:206` | JsonlPaneInner | working-start rising-edge snapshot (Phase-1-added) | trivial |
| `plugins/conversations/plugins/summary/web/components/summary-pane.tsx:66` | SummaryPaneInner | optimistic-cleanup on new `latest.id` | trivial |
| `plugins/conversations/plugins/summary/web/components/summary-pane.tsx:77` | SummaryPaneInner | timeout watchdog state machine | trivial |
| `plugins/debug/plugins/slow-ops/plugins/cluster/web/internal/use-cluster-stream.ts:95` | useClusterStream | NDJSON streaming accumulator | trivial |
| `plugins/debug/plugins/worktree-cleanup/web/components/worktree-cleanup-panel.tsx:134` | WorktreeCleanupPanel | NDJSON stream + AbortController | trivial |
| `plugins/infra/plugins/events-test/web/components/events-test-view.tsx:86` | EventsTestView | intentional 1s debug poll | trivial |
| `plugins/plugin-meta/plugins/plugin-health/web/components/health-section.tsx:56` | HealthSectionInner | async fetch+merge with cancel guard | trivial |
| `plugins/primitives/plugins/data-view/plugins/tree/web/components/editable-tree-label.tsx:42` | EditableTreeLabel | atomic `consumeAutoFocus()` + setEditing | trivial |
| `plugins/primitives/plugins/diff-view/web/components/image-diff-view.tsx:14` | useImageStatus | HTMLImageElement load lifecycle | trivial |
| `plugins/primitives/plugins/diff-view/web/components/text-diff.tsx:93` | useTextDiffData | async Shiki tokenization (no endpoint) | trivial |
| `plugins/primitives/plugins/diff-view/web/use-diff-tokens.ts:112` | useDiffTokens | 2× getFileContent + Shiki tokens fan-out | trivial · **LB** |
| `plugins/primitives/plugins/live-state/web/use-resource.ts:250` | useResource | gate first-settle transition (primitive internals) | trivial · **LB** |
| `plugins/primitives/plugins/sync-status/web/components/sync-status-indicator.tsx:91` | useDelayed | delay-before-show timer (rising/falling edge) | trivial · **LB** |
| `plugins/primitives/plugins/tree/web/internal/tree-list.tsx:142` | TreeList | optimistic-cleanup (rows are props) | trivial · **LB** |
| `plugins/primitives/plugins/tree/web/internal/tree-list.tsx:314` | TreeList | reveal-on-select ancestor walk | trivial · **LB** |
| `plugins/screenshot/web/components/screenshot-view.tsx:90` | ScreenshotView | poll-with-retry + BroadcastChannel | trivial |
| `plugins/screenshot/web/components/screenshot-view.tsx:199` | ImageStage | **refactor:** objectURL via `useMemo` + revoke-in-cleanup (no disable) | small |
| `plugins/primitives/plugins/css/plugins/color-picker/web/internal/color-picker.tsx:33` | ColorPicker | **refactor-or-disable:** make fully controlled if clean, else document the `lastEmitted` echo-guard | medium |
| `plugins/tasks/plugins/task-draft-form/web/components/task-draft-popover.tsx:282` | TaskDraftPopover | ref-gated new-card detector (historical diff) | trivial |

- **`screenshot-view.tsx:199`** is a clean refactor, not a disable: `const url = useMemo(() => URL.createObjectURL(blob), [blob])` + a cleanup-only effect that revokes.
- **`color-picker.tsx:33`** — try the fully-controlled rewrite (derive color from `value`,
  drop the mirror); if the slider-position echo loop can't be cleanly broken, keep the
  `lastEmitted` ref and document the disable.

---

## Ratchet (after iterate-to-zero)

In `plugins/framework/plugins/tooling/plugins/lint/core/build-lint-config.ts`:

1. Add the pin after the existing `"react-hooks/refs": "error"` (line 220):
   ```ts
   "react-hooks/set-state-in-effect": "error",
   ```
2. Update the comment block (lines ~209–212) that currently says *"Only the high-volume
   `set-state-in-effect` stays 'warn' … until its own burndown completes"* — record that it
   was ratcheted warn→error on 2026-06-24 once its count hit zero, and point at this doc.
   (Now **all** react-hooks compiler diagnostics are at `"error"`.)

---

## Iterate-to-zero loop (do before the ratchet)

1. Implement waves A–E.
2. `./equin build` (regenerates + rebuilds; runs `bun install`).
3. Re-scan: `bunx eslint "plugins/**/web/**/*.{ts,tsx}" -f json` → aggregate by `ruleId`.
   Fixing a component can surface a previously-masked sibling — **fix any newly-surfaced
   `set-state-in-effect` site and repeat** until it reports **0**.
4. Only then apply the ratchet and re-run `./equin check` (it must pass — proving the
   rule is truly at 0).

---

## Critical files

- `plugins/framework/plugins/tooling/plugins/lint/core/build-lint-config.ts` — the ratchet pin + comment (lines ~209–221).
- **New:** `plugins/primitives/plugins/syntax-highlight/web/internal/use-highlighted-html.ts` — the `useHighlightedHtml` hook (Wave E1); wire its export into the syntax-highlight web barrel.
- Load-bearing edits to spot-check: `live-state/web/use-resource.ts` (gate disable),
  `primitives/tree/web/internal/tree-list.tsx`, `sonata/shell/web/context.tsx`,
  `diff-view/web/{use-file-diff.ts,components/diff-view.tsx}`,
  `file-pane/web/use-file-content.ts`, `sync-status-indicator.tsx`, `use-mobile.ts`.
- Reuse (no new infra): `useEndpoint`/`useEndpointMutation`/`fetchEndpoint` from
  `@plugins/infra/plugins/endpoints/web`; `useResource` from
  `@plugins/primitives/plugins/live-state/web`; `useSyncExternalStore` precedent
  `reorder/web/internal/edit-mode-store.ts`; key-remount precedents
  `task-detail/web/panes.tsx:60`, `terminal-pane-body.tsx:39`.

## Suggested execution

The waves are independent and parallelizable. Recommended: a multi-agent workflow that
fans out per-wave (or per-file within a wave) using **worktree isolation** for parallel
edits, with each agent given its slice of the tables above + the exemption convention; then
a single iterate-to-zero + ratchet pass. Implementation agents on load-bearing files (Wave C
LB, all of E2 LB) should be Opus; the mechanical derive/key/disable edits are Sonnet work.

---

## Verification

1. **Scan delta:** `bunx eslint "plugins/**/web/**/*.{ts,tsx}" -f json` → `set-state-in-effect: 0` (and every other react-hooks rule still 0).
2. **Check green:** `./equin check` passes *after* the ratchet (proves 0).
3. **DOM tests:** `bun run test:dom` green.
4. **Build + boot:** `./equin build` succeeds; app boots at `http://<worktree>.localhost:9000`.
5. **Compiler correctness (G3):** bundle still contains `react/compiler-runtime`; the
   render-profiler still names real components (not `Memo`/`Unknown`); `remounts === 0`
   **except** at the intended `key=` boundaries (Wave B). Migrated components should now
   compile (one fewer un-memoized component each).
6. **Hot-path spot-checks (manual, scripted Playwright):**
   - Wave C: open a conversation → file-pane (raw + diff render), commits-graph, push/build/stats profiling panes, debug → memory panel, code-explorer fuzzy resolve.
   - Wave B: navigate between two tasks/agents/configs (state resets cleanly, no stale carryover); open/close command palette + quick-find (start fresh each open); diff-view file switch.
   - Wave A: sonata source picker + zoom (`spread`) clamp; slash/inline-date/page-link menus (first item highlighted after each keystroke).
   - Wave D: resize across the mobile breakpoint (`useIsMobile`); reorder edit-mode empty-state; boot-profile refresh.
   - E1: Shiki highlighting in code-block, raw file view, Read-tool code listing, HighlightedCode.
   - E2 LB: live-state updates on a conversation page (gate); tree expand/collapse + reveal-on-select (tasks/pages); sync-status cloud (saving→saved); jsonl "Working for Xs" counter.

---

## Risks

1. **Sibling bails surface after fixes.** Mitigated by the iterate-to-zero re-scan before the ratchet.
2. **Load-bearing migrations** (`use-resource` gate disable, `use-file-content`/`use-file-diff` → `useEndpoint`, `tree-list`, `sonata` context, `sync-status`). Edits are local and behavior-preserving; gated by the G3 protocol + the manual spot-checks above.
3. **`key=` remount semantics** discard in-progress local state at the keyed boundary — that *is* the intended reset (matches each effect's current behavior), but verify no consumer relied on the old "preserve draft across external change" behavior (notably `folder-picker`, `color-input`, `diff-view`).
4. **`useEndpoint` loading-on-input-change** differs from a manual `setState('loading')` reset (query-key change keeps prior data + `isFetching`). For `useFileContent`/`useFileDiff`/`useResolvedFile`, confirm the UI doesn't flash stale content; add an explicit reset if needed.
5. **Generated `use-mobile.ts`** edit could be overwritten by a future `shadcn add`. Low frequency; acceptable, with the inline-disable fallback noted.
6. **Ratcheting too early** turns `./equin check` red — only pin after the scan reads 0.

---

## Out of scope / follow-ups

- `useHighlightedTokens` sibling primitive to fold the diff-view Shiki *token* sites (`text-diff.tsx:93`, `use-diff-tokens.ts:112`) — currently documented disables.
- Live-state-backed resources for file content/diff (would replace the `useEndpoint` migrations with push-driven `useResource`) — a larger, separate change.
- The 242 non-compiler warnings (`@typescript-eslint/no-unnecessary-condition`, unused disable directives) — unrelated lint cleanup.
