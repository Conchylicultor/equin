# Eliminate the "background update yanks the user's scroll" bug class

## Context

**Reported symptom**: while editing a task description, the detail pane repeatedly
jumps back toward the top and the user has to scroll down again. The user notes
this class of bug recurs across surfaces and asked for a structural elimination,
not a spot fix.

**Root cause — reproduced and verified** (instrumented Playwright run against
this worktree; scroll-event, ResizeObserver, and stack-trace probes):

1. Typing in the description editor schedules `useEditableField`'s debounced
   autosave → `PATCH /api/tasks/:id`.
2. The PATCH bumps the task row → live-state pushes the keyed `tasks` resource →
   the deps-tree/creation-tree section (rendered **above** the Description
   section in the detail pane) re-derives its rows and the current task's row
   **remounts**.
3. `useTreeRow` (`plugins/primitives/plugins/tree/web/internal/use-tree-row.tsx:134`)
   has:
   ```ts
   useEffect(() => {
     if (isSelected && scrollRef.current) {
       scrollRef.current.scrollIntoView({ block: "nearest" });
     }
   }, [isSelected]);
   ```
   The dep `[isSelected]` cannot distinguish "selection just changed" from
   "row mounted already-selected", so every incidental remount of the selected
   row re-asserts it into view — captured in the probe as
   `scrollIntoView({block:"nearest"})` firing from `commitHookEffectListMount`
   ~1.5 s after each PATCH, yanking the pane scroll from 836 → 166 (the row's
   position). `block:"nearest"` does not save us: the user is scrolled to the
   editor below, so the row IS out of view and the scroll is real.

**The class**: *positioning side-effects (`scrollIntoView`, scroll writes) keyed
on state instead of user intent, re-fired by background churn (live-state pushes
remounting rows).* A repo sweep found 10 hand-rolled `scrollIntoView` sites, all
writing the same idiom with ad-hoc (or absent) mount guards:

| Site | Trigger | Mount-fire today | Verdict |
|---|---|---|---|
| `primitives/tree` `use-tree-row.tsx:136` | `[isSelected]` | fires on every remount | **the bug** |
| `apps-core/tab-bar` `app-tab-bar.tsx:242` | `[active]` | fires; intended (new tab reveals itself in strip) | keep mount-reveal, make explicit |
| `code/file-pane/raw` `raw-view.tsx:77` | `[line, html]` | fires; intended (deep-link to line) | keep, make explicit |
| `search/quick-find` `:122`, `command-palette` `:148`, `sonata/ug-import` `:169` | `[activeIdx]` keyboard nav | no-op at mount (list empty) — safe by accident | migrate, semantics unchanged |
| `page/editor` `block-type-list.tsx:118` | `[active]` keyboard/hover | harmless (menu mounts fresh) | migrate |
| `sonata/songsheet` `:133` | `[activeLine, isPlaying]` playback follow | intended (jump to playhead) | migrate |
| `jsonl-viewer` `jsonl-pane.tsx:93` | `[expanded]` user click, stable element | safe by construction | migrate |
| `jsonl-viewer/message-toc` `:71` | click handler (imperative) | n/a | migrate to imperative helper |

There is today **no sanctioned owner** for "reveal element on activation" (the
way `element-size` owns ResizeObserver, `auto-scroll` owns bottom-pin), and no
lint rule preventing the next hand-rolled instance. That is why the class
recurs.

## Design

Three layers: a primitive that makes the correct semantics the only expressible
ones, migration of every existing site, and a lint rule that prevents new
hand-rolls. (Same shape as `element-size` + `no-raw-resize-observer`.)

### 1. New primitive: `plugins/primitives/plugins/scroll-reveal/`

Pure-web behavior primitive (folder template: mirror
`plugins/primitives/plugins/hover-reveal/` — `web/index.ts` barrel +
`web/internal/`, no core/server, `contributions: []`).

```ts
// web/internal/use-reveal-on-active.ts
export interface RevealOptions {
  behavior?: ScrollBehavior;         // default "auto"
  block?: ScrollLogicalPosition;     // default "nearest"
  inline?: ScrollLogicalPosition;    // default "nearest"
}

/** Scrolls the attached element into view when `isActive` TRANSITIONS
 *  false→true while mounted. Never fires because the element remounted
 *  already-active — that is the entire point of the primitive.
 *  `revealOnMount` opts into ONE reveal on mount when mounting already-active
 *  (deep-link / new-tab cases); pass a function for a lazily-consumed one-shot
 *  intent (the tree's initial-mount reveal). */
export function useRevealOnActive(
  isActive: boolean,
  opts?: RevealOptions & { revealOnMount?: boolean | (() => boolean) },
): (el: HTMLElement | null) => void;

/** Imperative form for genuine event handlers (click-to-scroll TOC, effects
 *  with bespoke re-fire keys like raw-view's [line, html]). */
export function revealElement(el: Element | null | undefined, opts?: RevealOptions): void;
```

Implementation notes:

- Callback-ref + `useEffect`; a `prevActiveRef` distinguishes transition from
  mount. On the first effect run: reveal only if `isActive` and `revealOnMount`
  resolves true. On later runs: reveal on `false→true`.
- `revealElement` is a thin wrapper over `el.scrollIntoView(...)` — it exists so
  the lint rule has a sanctioned funnel, and so future cross-cutting policy
  (e.g. "suppress reveals while a text editor elsewhere has focus") has one
  home. Do **not** add such policy now; the transition semantics alone kill the
  observed class.

### 2. Fix the tree (the live bug)

`plugins/primitives/plugins/tree/web/internal/use-tree-row.tsx`:

- Replace the `[isSelected]` effect with
  `useRevealOnActive(isSelected, { revealOnMount: ctx.takeInitialReveal })`,
  merging the returned ref into `wrappedChildRef`.
- `tree-list.tsx`: add a per-instance one-shot `takeInitialReveal` to the tree
  context — `const initialReveal = useRef(true)` and
  `takeInitialReveal: () => { const v = initialReveal.current; initialReveal.current = false; return v; }`.
  This preserves the one legitimate mount-reveal (a tree that first appears with
  a deep-linked selection below the fold, e.g. the Tasks sidebar) while making
  row **re**mounts inert. Mirrors the existing one-shot-intent pattern of
  `pending-focus.ts` (set/take, consumed exactly once).

### 3. Migrate the remaining sites

Mechanical swaps, semantics preserved:

- `app-tab-bar.tsx` TabChip → `useRevealOnActive(active, { revealOnMount: true, inline: "nearest" })`.
- `quick-find-dialog.tsx`, `command-palette-dialog.tsx`, `ug-import-dialog.tsx`,
  `block-type-list.tsx` → `useRevealOnActive(isActive)` on the row (attach ref to
  the active row) — replaces the `[activeIdx]`-keyed container effects with the
  per-row transition hook; keyboard-nav behavior unchanged.
- `songsheet.tsx` → keep the `isPlaying` gate, body becomes
  `revealElement(lineRefs.current[activeLine], { behavior: "smooth", block: "center" })`.
- `raw-view.tsx` → keep its own `[line, html]` effect, body becomes
  `revealElement(el, { block: "center", behavior: "smooth" })` (bespoke re-fire
  key; the imperative form is the sanctioned path for that).
- `jsonl-pane.tsx` StickyUserHeader → `revealElement(ref.current, { behavior: "smooth", block: "start" })`.
- `message-toc.tsx:71` click handler → `revealElement(el, { behavior: "smooth", block: "start" })`.

### 4. Lint rule: `scroll-reveal-safety` / `no-adhoc-scroll-into-view`

New lint plugin
`plugins/framework/plugins/tooling/plugins/lint/plugins/scroll-reveal-safety/`
(mirror `resize-observer-safety` byte-for-byte: same `lint/index.ts`
`{ name, rules, ignores }` shape, same `ESLintUtils.RuleCreator` skeleton,
syntactic only — no type info):

- **Ban** `CallExpression` of member `.scrollIntoView` and `.scrollIntoViewIfNeeded`.
- Message: route through `useRevealOnActive` / `revealElement` from
  `@plugins/primitives/plugins/scroll-reveal/web`; extend the primitive rather
  than copying it.
- `ignores`: only the primitive's own
  `plugins/primitives/plugins/scroll-reveal/web/internal/use-reveal-on-active.ts`.
  All call sites are migrated in this task, so **no burndown list**.
- **Deliberately out of scope**: banning `.scrollTop =` / `.scrollTo(`. Those
  belong to the *bottom-pin* idiom whose sanctioned owner is `auto-scroll`
  (`useStickyScroll`), and the three hand-rolled instances
  (`debug/logs/log-viewer.tsx:133`, `sonata/chord-progression:154`,
  `message-toc.tsx:119`) are a different migration. Extending the rule there is
  a follow-up (see §6) — do not scope-creep this task.

### 5. Docs

- `scroll-reveal/CLAUDE.md`: short hand-prose stating the invariant ("a reveal
  fires on activation *transition* or explicit intent — never because an element
  remounted already-active; background data churn must never move the user's
  scroll") + autogen block.
- One-line mention in the lint plugin's CLAUDE.md, per convention.

### 6. Adjacent findings — file as follow-up tasks (via `add_task`), NOT in this change

Discovered and verified during the investigation; distinct mechanisms of the
broader "background churn destroys user context" family:

1. **`PaneResolveGuard` unmounts a live pane on a resource blip**
   (`primitives/pane/web/components/pane-resolve-guard.tsx`): once `found` has
   been true, a transient flip back to `pending` (e.g. transient HTTP-fallback
   error under host pressure) swaps the whole mounted pane for `Loading` chrome
   — losing scroll, focus, and up to 500 ms of unsaved editor draft (the
   debounce timer is cleared on unmount without saving). Fix direction:
   sticky-found per (pane, params) — only downgrade on a settled not-found.
2. **`TextEditor`'s `ValueSyncPlugin` re-applies the whole document on external
   `value` change** (`applyMarkdownToEditor` does `root.clear()` + rebuild,
   destroying selection/scroll). Today only `useEditableField`'s focus-gate
   *outside* the editor prevents this from firing mid-edit; the editor itself
   should own the guard (defer external applies while focused, or diff-apply).
3. **Deps-tree rows remount on every task push** — the render-churn that
   triggered the bug; harmless once §2 lands but worth a render-profiler pass
   (it names remount causes: key-change vs element-type flip).
4. Optional: extend `no-adhoc-scroll-into-view` to `.scrollTop =` / `.scrollTo(`
   with `auto-scroll` exempted and the three hand-rolled bottom-pin sites
   migrated to `useStickyScroll`.

## Files touched

- **new** `plugins/primitives/plugins/scroll-reveal/{package.json,CLAUDE.md,web/index.ts,web/internal/use-reveal-on-active.ts}`
- **new** `plugins/framework/plugins/tooling/plugins/lint/plugins/scroll-reveal-safety/{package.json,CLAUDE.md,lint/index.ts,lint/no-adhoc-scroll-into-view.ts}`
- `plugins/primitives/plugins/tree/web/internal/use-tree-row.tsx` + `tree-list.tsx` (+ context type)
- the 8 migrated call sites listed in §3
- registries regenerate via `./equin build` (no manual edits)

## Verification

1. `./equin build` (regenerates registry, deploys) then re-run the repro:
   `bun <scratchpad>/scroll-jump-repro.mjs --url http://att-1784327226-eebi.localhost:9000/agents/tasks/t/task-1784326319521-u1802y`
   — assert **no** `SCROLL-JUMP` lines in the ~1.5 s window after each `PATCH`
   (before the fix: one per save, 836 → 166). The probe scripts live in the
   session scratchpad (`scroll-jump-repro.mjs`, `scroll-caller-probe.mjs`).
2. Deep-link reveal still works: open `/agents/tasks/t/<id>` for a task far down
   the Tasks sidebar — the selected row is scrolled into view exactly once.
3. Keyboard nav in Cmd+K / quick-find still follows the highlight past the fold.
4. New-tab reveal in the tab strip still works (open many tabs, spawn one more).
5. `./equin check` — the new lint rule passes repo-wide (all sites
   migrated), `type-check` green.
6. `bun run test:dom plugins/primitives/plugins/tree` (existing tree suites, if
   present) — unchanged behavior on selection transitions.
