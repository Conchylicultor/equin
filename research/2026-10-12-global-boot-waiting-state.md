# Boot waiting / stuck state — the boot root can never render nothing

## Context

Incident 2026-10-12 16:28–16:55: main's backend was wedged, `GET /api/resources/boot-snapshot`
never answered, and every tab showed a black, empty page for ~27 min — no spinner, no error,
no elapsed time, nothing to tell the user or an agent what was stuck.

Root cause in code (`plugins/framework/plugins/web-core/web/App.tsx`):

- `App` holds `state: LoadedState | null` and does `if (!state) return null;`.
- `state` is set only after `await runBootTasks(eagerResult.plugins)`, which
  `Promise.allSettled`s every `Core.Boot` task with **no deadline**. One hung task
  (`infra/boot-snapshot`'s `runBootSnapshot` → `fetchEndpoint(bootSnapshot)`) keeps the root
  at `null` forever. A *rejected* task is only `console.error`'d and boot proceeds.
- `Core.Boot` (`web-sdk/core/slots.ts`) is `{ run }` — a task carries no name, so nothing
  could even say *what* is stuck.

This violates "not-known-yet is a state to render": the one place where every app is affected
at once renders the stand-in for "nothing".

Outcome: from the first React commit the page shows a (grace-delayed) waiting state naming
what it waits for and for how long; a failed or overdue boot task turns it into a loud error
state with Retry / Continue anyway, and files a client report. The normal boot is visually
unchanged and no slower.

## Design

### 1. Boot is a state, not a `null` (by construction)

Replace `LoadedState | null` with a discriminated union and an exhaustive render:

```ts
type BootState =
  | { phase: "loading-code"; startedAt: number }
  | { phase: "boot-tasks"; startedAt: number; tasks: BootTaskStatus[] }
  | { phase: "ready"; plugins: LoadedPlugin[]; coreErrors: PluginLoadError[] };

type BootTaskStatus = {
  label: string;
  ifUnavailable: "block" | "continue";
  status:
    | { kind: "pending" }
    | { kind: "done" }
    | { kind: "overdue" }                    // past BOOT_TASK_DEADLINE_MS, still pending
    | { kind: "failed"; message: string };   // rejected (HTTP status / network error text)
};
```

`App` switches on `phase`; the two non-ready phases render `<BootScreen>`. There is no
`return null` arm left — "boot root with no data renders nothing" has no spelling (rung 1/2).
`useState` initialises to `{ phase: "loading-code", startedAt: performance.now() }`, so the
**first commit** already contains the boot screen (the incident's "create-root/first-commit
fired, #root empty" becomes "#root holds `[data-boot-state]`").

### 2. `Core.Boot` tasks declare a label and whether the app can run without them (tsc)

`web-sdk/core/slots.ts`:

```ts
Boot: defineSlot<{
  /** What the user is waiting for, shown on the boot screen ("Boot snapshot"). */
  label: string;
  /** "block": the app cannot meaningfully paint without it — failure/overdue shows the
   *  error screen. "continue": it degrades on its own — overdue/failure is reported and
   *  boot proceeds without it. */
  ifUnavailable: "block" | "continue";
  run: () => Promise<void>;
}>(),
```

Both fields required, so every current and future task must say both. Update the two
contributors:

- `infra/boot-snapshot/web/internal/boot.ts` → `{ label: "Boot snapshot", ifUnavailable: "block", run }`.
- `ui/theme-engine/plugins/saved-themes/web/boot.ts` → `{ label: "Saved themes", ifUnavailable: "continue", run }`
  (its comment already documents that it degrades via the pre-paint CSS cache).

Update the slot's comment ("a hung task must never brick boot" becomes: bounded by a deadline;
a `block` task's failure is shown, not hidden).

### 3. Boot-task sequencer with a deadline (new `web-core/web/boot-tasks.ts`)

Pull `runBootTasks` out of `App.tsx` into a small module that:

- runs every task, tracking each `BootTaskStatus` and publishing changes through an
  `onChange(tasks)` callback (App `setState`s it → `phase: "boot-tasks"`);
- arms one `setTimeout(BOOT_TASK_DEADLINE_MS = 15_000)` for the whole batch (a deadline, not
  polling); at expiry every still-pending task becomes `overdue`;
- **never aborts** the underlying promise: if an overdue task later resolves, it flips to
  `done` and boot continues by itself (the wedge-then-restart case recovers with no reload);
- resolves the batch when every task is `done`, or every non-done task is `continue`-kind and
  failed/overdue; a `block` task that is `failed`/`overdue` holds the screen until it settles
  or the user clicks **Continue anyway** (resolves the batch as-is; reads then show their
  own per-resource pending states and self-heal via the WS — today's failure behaviour).
- Reports (step 5) once per task on `failed` and on `overdue`.

The deferred tier (`loadDeferredBatch`) uses the same sequencer for deadline + reporting,
without the screen (no `Core.Boot` there today).

### 4. `<BootScreen>` (new `web-core/web/components/boot-screen.tsx`)

Props: the non-ready `BootState` + `onContinue`. Root element `data-boot-state` =
`loading-code | waiting | stuck | failed` (the e2e hook).

- **waiting** (`loading-code`, or `boot-tasks` with all pending): centred, muted:
  "Waiting for the server…" (or "Loading the app…" in `loading-code`), the pending labels
  ("Boot snapshot"), and `<ElapsedTime since={…}/>` from
  `@plugins/primitives/plugins/relative-time/web` (its `useNow` is a presentational ticker,
  allowed by the no-polling rule).
  **Grace**: the element is in the DOM from the first commit but its contents fade in via a
  CSS `animation-delay` of ~1 s (same pure-CSS technique as `primitives/loading`'s
  delay-before-show, no JS timer). A normal boot (~0.3–0.6 s) unmounts it first → visually
  unchanged. The ticker starts only inside the faded-in part, so no extra commits on the
  normal path.
- **stuck** (`block` task overdue) / **failed** (`block` task rejected): shown immediately
  (no grace), destructive tone: "The server isn't answering" / "Couldn't load the app's
  data", naming each task + elapsed / its error message, a note "This page continues on its
  own if the server answers", and two buttons: **Retry** (`location.reload()`) and
  **Continue anyway**.
- Styling: theme tokens only (index.html's pre-paint replay + `app.css` already provide them
  before React mounts), `Text`/`Button` from the ui-kit like `components/plugin-load-errors.tsx`;
  `fixed inset-0` with the same documented "renders before overlay providers" lint
  disable. Run the `css` / `theme` skills before writing it.

Optional belt-and-braces (decide at implementation, cheap): a static
`<div id="root"><div class="boot-static">Loading…</div></div>` in `web-core/web/index.html`
with a 2 s CSS delay, covering a JS bundle that never loads (React replaces it on mount).

### 5. Client-side report into the alert funnel

On a task's `failed` or `overdue`, `App` calls `report()` from `@plugins/reports/web` — the
same direct keepalive POST `boot-snapshot/web/internal/boot.ts` already uses because the crash
collector is not mounted during boot:

- new client source `"client-boot"` in `plugins/reports/core/sources.ts` (`CLIENT_REPORT_SOURCES`);
- `kind: "crash"`, `errorType: "BootTaskOverdue" | "BootTaskFailed"`, message
  `boot: "<label>" pending for 15 s` / `boot: "<label>" failed: <msg>`, data includes
  elapsed ms and the pending labels.

Caveat to state in the code comment: in a fully wedged backend this POST may itself stall;
the server's span-stuck traces cover that side, and the report lands if the backend recovers.
Verify with `./singularity check boundary-rules` that `web-core/web/App.tsx` may import
`reports/web` (it already imports several feature/primitive web barrels); if not, fall back to
a held `bootReportSink` in web-sdk mirroring `pluginLoadReportSink`, registered at module
eval by the reports plugin.

### 6. Keep the boot-trace instants honest

`boot-snapshot` arms `FIRST_DATA_COMMIT_ID` via `markBootInstantAtNextCommit` right after
hydrate, relying on "App renders null until boot tasks resolve" — with a boot screen (and its
ticker on slow boots) the "next commit" could be a boot-screen commit. Move that arm into
`App`, immediately before the `phase: "ready"` setState (next to the existing
`markRouteContentAtNextCommit`), and drop it from `boot.ts`. Same id and label, so
`cold-start` / `boot-bench` consumers are unaffected.

## Files

- `plugins/framework/plugins/web-sdk/core/slots.ts` — `Core.Boot` shape + comment.
- `plugins/framework/plugins/web-core/web/App.tsx` — `BootState` union, exhaustive render,
  sequencer wiring, report, FIRST_DATA_COMMIT arm.
- `plugins/framework/plugins/web-core/web/boot-tasks.ts` (new) — sequencer + deadline.
- `plugins/framework/plugins/web-core/web/components/boot-screen.tsx` (+ css) (new).
- `plugins/infra/plugins/boot-snapshot/web/internal/boot.ts` — label/ifUnavailable, drop instant arm; CLAUDE.md note.
- `plugins/ui/plugins/theme-engine/plugins/saved-themes/web/boot.ts` — label/ifUnavailable.
- `plugins/reports/core/sources.ts` — `"client-boot"`.
- `plugins/infra/plugins/boot-snapshot/e2e/boot-stall.ts` (new) — e2e.
- Tests: `web-core/web/__tests__/boot-screen.test.tsx` (new); adjust `app-load-errors.test.tsx`
  / `boot-snapshot/web/__tests__/*` for the new Core.Boot shape.

## Verification

1. **jsdom** (`./singularity test plugins/framework/plugins/web-core`): never-resolving `block`
   task → `[data-boot-state=waiting]` in the first commit; fake timers past 15 s → `stuck` +
   one `report` call; rejecting task → `failed` at once; overdue task resolving later → app
   renders `Core.Root`; `continue` task overdue → app renders, report filed; Continue anyway
   → app renders.
2. **e2e** `./singularity run plugins/infra/plugins/boot-snapshot/e2e/boot-stall.ts`
   (harness `stallRoute`, `withBrowser`, `report()`):
   - stalled snapshot: `[data-boot-state=waiting]` attached within ~1 s of navigation, visible
     text names "Boot snapshot" and an elapsed clock; after the deadline `stuck` with Retry /
     Continue anyway; release the stall → the app renders by itself;
   - 503 via `route.fulfill` → `failed` immediately, error text includes the status;
   - normal load → boot screen removed before its fade-in (assert it never reached opacity > 0
     via a MutationObserver/`getComputedStyle` sample), app renders.
   Screenshots of each state with `--color-scheme dark|light`.
3. **No slower**: `cold-start.ts` / `benchmark_boot` before vs after — `boot:first-commit`,
   `first-data-commit`, `route-content` within noise.
4. `./singularity build` (checks incl. boundary-rules, type-check, plugins-doc-in-sync).
