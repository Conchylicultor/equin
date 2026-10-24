# Decouple `infra.health` from `reports` via a shared `defineReportSink` primitive

## Context

Every gateway-served app composition `extends` `served-baseline`, which seeds
`infra.health` as an entry point. `infra.health`'s web watchdog
(`wedge-watchdog.tsx`) hard-imports `report` from `@plugins/reports/web`. Because
the composition closure graph is **plugin-level** (a plugin node bundles all its
runtimes' imports), this one web edge pulls the entire `reports` plugin node —
and its server-side closure — into every served app:

```
served-baseline → infra.health → reports        (EDGE 1, web import — the linchpin)
                                  reports/server → tasks + build   (EDGE 2)
                                                    build → git-watcher → worktree
```

Net effect: the hard closure of every served app (Sonata, pages, settings,
home, …) contains `reports`, `tasks`, `build`, `git-watcher`, and `worktree` —
agent/worktree/git-runtime infrastructure a self-contained release must not ship.

The intended outcome: **cut Edge 1** so `reports`/`tasks`/`build`/`git-watcher`/
`worktree` leave `served-baseline`'s hard closure, then prove the win by opting
Sonata into the `composition-closure` guard via `excludes`.

**Edge 2 is out of scope here** (filed as follow-up task
`task-1782913270618-mdrawn`): even after Edge 1 is cut, `reports` itself stays
welded to the agent runtime, so an app that *wants* reporting still can't be
self-contained. That is the deeper decoupling and is deferred.

### Why a shared primitive (not a local slot)

The codebase already inverts this exact dependency twice — a low-level plugin
that wants to file a crash report owns a **module-level reporter slot**, and
`reports` registers into it (`reports → primitive`, never the reverse):

- `primitives/error-boundary/web/reporter.ts` — `registerBoundaryReporter` /
  `callReporter` over `BoundaryErrorReport`; registered by
  `reports/crash/web/components/crash-collector.tsx`.
- `infra/endpoints/web/internal/error-reporter.ts` —
  `registerEndpointErrorReporter` / `reportEndpointError` over
  `EndpointErrorInfo`; registered by
  `reports/endpoint-errors/web/components/endpoint-error-reporter.tsx`. Its own
  comment says it "Mirrors `registerBoundaryReporter`".

These are two byte-for-byte copies of the same `let reporter; register; call +
try/catch` idiom, each documented as mirroring the other. Adding `infra.health`'s
wedge reporter would be a **third** copy. Instead we extract the idiom into one
generic factory and migrate all three consumers onto it — the single primitive
that makes this and any future soft-report inversion trivial.

## Decisions (locked with user)

1. **Extract a shared `defineReportSink` factory**; migrate all three consumers
   (`error-boundary`, `endpoints`, `infra.health`) onto it.
2. **Sonata-only** `excludes` as a working proof; roll-out to the other served
   apps is a follow-up.
3. **Follow-up filed** (`task-1782913270618-mdrawn`) to investigate cutting
   Edge 2 (reports ↔ tasks/build).

## Design: `defineReportSink`

New leaf web primitive: **`plugins/primitives/plugins/report-sink/`** (web-only,
no server/core, depends on nothing — so `error-boundary`, `endpoints`, and
`health` can all import it with no cycle).

```ts
// web/internal/define-report-sink.ts
export interface ReportSink<TBody, TResult> {
  register(fn: ((body: TBody) => TResult) | null): void;
  emit(body: TBody): TResult | undefined;
}

// A module-level soft-reporter slot. The primitive owning the sink defines its
// own neutral TBody; `reports` registers the mapping to report(). emit() never
// throws — it is called on error paths.
export function defineReportSink<TBody, TResult = void>(): ReportSink<TBody, TResult> {
  let handler: ((body: TBody) => TResult) | null = null;
  return {
    register(fn) { handler = fn; },
    emit(body) {
      try { return handler?.(body); }
      // eslint-disable-next-line promise-safety/no-bare-catch -- reporting must never throw on the error path
      catch { return undefined; }
    },
  };
}
```

`web/index.ts` barrel: `export { defineReportSink } from "./internal/define-report-sink"; export type { ReportSink } from "./internal/define-report-sink";`
plus the standard `export default { … } satisfies PluginDefinition` (no
contributions).

**Contract preserved from the two precedents:** each consumer owns its **neutral**
`TBody` (no reports vocabulary leaks into the primitive); `reports` owns the
mapping + policy (which errors to file, fingerprint, muting) in its registered
callback; `emit` swallows throws.

### Migration — consumer side (each defines + exports one sink)

**`primitives/error-boundary`**
- `web/reporter.ts`: keep the `BoundaryErrorReport` interface; replace the
  hand-rolled `reporter`/`registerBoundaryReporter`/`callReporter` with
  `export const boundaryReportSink = defineReportSink<BoundaryErrorReport, Promise<unknown> | unknown | void>();`
- `web/components/plugin-error-boundary.tsx:66`: `callReporter(report)` →
  `boundaryReportSink.emit(report)`.
- `web/index.ts`: export `boundaryReportSink` (drop `registerBoundaryReporter`);
  keep `export type { BoundaryErrorReport }`.

**`infra/endpoints`**
- `web/internal/error-reporter.ts`: keep `EndpointErrorInfo`; replace the slot
  with `export const endpointErrorSink = defineReportSink<EndpointErrorInfo>();`
- `web/internal/fetch-endpoint.ts:110`: `reportEndpointError({…})` →
  `endpointErrorSink.emit({…})`.
- `infra/ndjson-stream/web/internal/read-ndjson.ts:14`: same call-site swap
  (import `endpointErrorSink` from `@plugins/infra/plugins/endpoints/web`).
- `web/index.ts`: export `endpointErrorSink` (drop `registerEndpointErrorReporter`
  + `reportEndpointError`); keep `export type { EndpointErrorInfo }`.

**`infra/health`** (the actual cut)
- New `web/internal/wedge-report-sink.ts`:
  ```ts
  import { defineReportSink } from "@plugins/primitives/plugins/report-sink/web";
  export interface WedgeReport { discriminator: string; message: string }
  export const wedgeReportSink = defineReportSink<WedgeReport>();
  ```
  (`benign` stays health-local — it only drives the toast + message wording,
  which are already composed before emit; it is not part of the report body.)
- `web/components/wedge-watchdog.tsx`: delete `import { report } from
  "@plugins/reports/web"` (line 5); replace the `report({ kind:"crash",
  source:"live-state-wedge", … })` call (lines 64–76) with
  `wedgeReportSink.emit({ discriminator, message })`. The toast, cooldown, and
  benign/message logic (lines 47–58, 67–69) are unchanged. **After this,
  `infra.health` imports nothing from `reports`.**
- `web/index.ts`: `export { wedgeReportSink } from "./internal/wedge-report-sink";
  export type { WedgeReport } from "./internal/wedge-report-sink";`

### Migration — `reports` side (registers the mappings)

- **`reports/crash`** owns crash-kind soft sources. Update
  `crash-collector.tsx`: `registerBoundaryReporter(fn)` →
  `boundaryReportSink.register(fn)`, `registerBoundaryReporter(null)` →
  `boundaryReportSink.register(null)`. Add the wedge mapping (either in
  `crash-collector.tsx`'s effect or a sibling `wedge-reporter.tsx` Core.Root in
  the crash barrel):
  ```ts
  wedgeReportSink.register((w) => {
    void report({
      kind: "crash", source: "live-state-wedge", message: w.message,
      url: window.location.href, userAgent: navigator.userAgent,
      data: { errorType: `LiveStateWedge:${w.discriminator}`, label: "live-state.watchdog" },
    });
  });
  // cleanup: wedgeReportSink.register(null)
  ```
  `"live-state-wedge"` stays in `reports/shared/types.ts` `CLIENT_REPORT_SOURCES`
  — no source literal leaves `reports`.
- **`reports/endpoint-errors`** `endpoint-error-reporter.tsx`:
  `registerEndpointErrorReporter(fn)` → `endpointErrorSink.register(fn)` (and the
  `null` cleanup). `buildReport` + the `bugShaped` filter are unchanged.

> Registration stays in each report **domain** sub-plugin (crash owns
> boundary + wedge, both `kind:"crash"`; endpoint-errors owns endpoint). The
> shared *mechanism* is now single-sourced in `defineReportSink`; the per-domain
> *mappings* rightly stay with their report kind. (A single consolidated reports
> "bridge" component was considered and rejected — it would pull each
> sub-plugin's mapping/policy across sub-plugin boundaries.)

### Prove the cut — Sonata `excludes`

In `plugins/plugin-meta/plugins/composition/core/config.ts`, change the Sonata
seed (line 95):

```ts
app("sonata", "a6", "apps.sonata", [], ["agent-runtime", "auth"]),
```

The `app()` factory already accepts `(name, rank, entry, extraExtends=[],
excludes=[])`. Update the NOTE comment (lines 90–94) to reflect that the linchpin
edge is cut and Sonata is opted in (leave the roll-out-to-other-apps note as
follow-up).

## Files touched

- **new** `plugins/primitives/plugins/report-sink/web/index.ts`
- **new** `plugins/primitives/plugins/report-sink/web/internal/define-report-sink.ts`
- `plugins/primitives/plugins/error-boundary/web/reporter.ts`
- `plugins/primitives/plugins/error-boundary/web/index.ts`
- `plugins/primitives/plugins/error-boundary/web/components/plugin-error-boundary.tsx`
- `plugins/infra/plugins/endpoints/web/internal/error-reporter.ts`
- `plugins/infra/plugins/endpoints/web/internal/fetch-endpoint.ts`
- `plugins/infra/plugins/endpoints/web/index.ts`
- `plugins/infra/plugins/ndjson-stream/web/internal/read-ndjson.ts`
- **new** `plugins/infra/plugins/health/web/internal/wedge-report-sink.ts`
- `plugins/infra/plugins/health/web/components/wedge-watchdog.tsx`
- `plugins/infra/plugins/health/web/index.ts`
- `plugins/reports/plugins/crash/web/components/crash-collector.tsx` (+ optional new `wedge-reporter.tsx` and barrel wiring)
- `plugins/reports/plugins/endpoint-errors/web/components/endpoint-error-reporter.tsx`
- `plugins/plugin-meta/plugins/composition/core/config.ts`

## Verification

1. `./equin build` — regenerates the plugin registry for the new
   `report-sink` plugin and rebuilds; also refreshes the autogen CLAUDE.md
   "Uses" blocks (`infra.health` should no longer list `reports.report`).
2. `./equin check composition-closure` — must pass. This is the proof:
   Sonata's `excludes: ["agent-runtime", "auth"]` fails if its hard closure
   still reaches any agent-runtime taproot. If an offender remains, the check
   prints it + the `explainInclusion` path; trace and confirm whether it is a
   residual reports edge (bug in the cut) or a genuine Sonata dependency (drop
   that exclude / file separately).
3. `./equin check` — full check pass (`type-check`, `plugin-boundaries`,
   `plugins-doc-in-sync`, `plugins-registry-in-sync`).
4. `bun test plugins/plugin-meta/plugins/composition/core/config.test.ts` — the
   seed/taxonomy test still parses with the new Sonata `excludes`.
5. Manual sanity in the full agent-manager app
   (`http://<worktree>.localhost:9000`): reporting paths still fire — a caught
   render error still surfaces the boundary fallback + files a crash; the
   live-state wedge path still files (exercise via the Debug → Live-State Emit
   pane or by forcing a socket-down). Confirm `reports/crash` is present (it is,
   via the `self-improvement` pack) so the wedge/boundary sinks have a
   registrant.

## Risks / notes

- **Load-bearing surfaces.** `endpoints` and `error-boundary` are load-bearing;
  the migration is a mechanical call-site swap that preserves each sink's exact
  semantics (including the boundary's Promise-returning `emit`). No behavior
  change intended.
- **Served apps lose wedge/crash reporting** — intended: `reports.crash` isn't
  in a served app's closure, so the sinks simply have no registrant and `emit`
  no-ops. A standalone released app has no agent backend to report to.
- **New plugin ⇒ build required** before `check` (registry codegen), per the
  `plugins-registry-in-sync` check.
- Edge 2 (`reports` still welded to tasks/build/worktree) is **not** addressed
  here — see `task-1782913270618-mdrawn`.
