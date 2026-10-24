# Bug-shaped handled client errors should file crash tasks

## Context

A user creating a follow-up task hit `Validation failed … Invalid discriminator value. Expected 'metaTask' | 'folder'` (path `target.kind`). Root cause: a **stale browser bundle** still POSTing the pre-rename shape `{kind:"child", parentTaskId}` to `POST /api/tasks/chain` after commit `9b7fe1f45` renamed child→folder. The server (new build) correctly rejected it.

The problem isn't that one bug — it's that the failure surfaced only as a transient warning toast/notification and was **never filed as a crash task**. The crash reporter (`plugins/crashes/web/components/crash-reporter.tsx`) only hooks the three *uncaught* sources (window `error`, `unhandledrejection`, React boundaries). A handled endpoint error (a 4xx/5xx response the client code catches) reaches none of them. The `crashes/plugins/mutation-errors` watcher observes only the TanStack **MutationCache** and only toasts; and the task-draft-form submit path uses a raw `fetch()` that bypasses even that.

**Decision (with user):** these *are* worth crash tasks — tasks exist for agents to investigate, and a validation error reaching the client almost always means a real structural defect (schema/bundle skew). We file crashes for **bug-shaped** errors only, to avoid noise from expected control-flow responses:

- **File a crash** for: validation 400s (body `{error:"Validation failed"|"Query validation failed", issues:[]}`) **and** any status `>= 500`.
- **Skip**: 401 / 403 / 404 / 409 and non-validation 400s (these are legitimate control flow — e.g. the block editor's "no previous sibling to merge" 400).

Intended outcome: any bug-shaped error that flows through the typed endpoint layer — imperative `fetchEndpoint`, `useEndpoint` queries, and `useEndpointMutation` — files a deduped crash task, regardless of whether the caller also handles it locally.

## Approach

**One chokepoint, inverted dependency.** Every non-ok endpoint response funnels through a single throw site in `fetch-endpoint.ts` (`useEndpointMutation`'s mutationFn calls `fetchEndpoint` too). We add an inversion hook there — exactly mirroring the existing `registerBoundaryReporter` (`plugins/primitives/plugins/error-boundary/web/reporter.ts`) and server `setErrorReporter` patterns — so the **endpoints primitive never imports the crashes feature plugin**. The primitive stays domain-agnostic: it fires the hook for *every* non-ok response; the registered reporter (owned by crashes) decides what is bug-shaped and files it.

The raw-`fetch` task-draft-form submit is migrated onto `fetchEndpoint(createTaskChain, …)` so it benefits from the same chokepoint (the endpoint contract already exists and is server-validated).

### Why not the MutationCache observer
Extending `mutation-errors` would only catch `useEndpointMutation` errors — `fetchEndpoint`/`useEndpoint` imperative + query errors never populate the mutation cache. The throw-site hook catches all three for free.

## Changes

### 1. Inversion hook in the endpoints primitive
**CREATE** `plugins/infra/plugins/endpoints/web/internal/error-reporter.ts` — single nullable singleton (overwrite, not array), try/catch-wrapped so it can never throw (mirror `error-boundary/web/reporter.ts:17-31`):
```ts
export interface EndpointErrorInfo { route: string; status: number; body: unknown }
type Reporter = (info: EndpointErrorInfo) => void;
let reporter: Reporter | null = null;
export function registerEndpointErrorReporter(fn: Reporter | null): void { reporter = fn; }
export function reportEndpointError(info: EndpointErrorInfo): void {
  try { reporter?.(info); } catch { /* reporting must never throw */ }
}
```

**MODIFY** `plugins/infra/plugins/endpoints/web/internal/fetch-endpoint.ts` (throw site ~line 95) — immediately before `throw new EndpointError(res.status, errorBody)`, call
`reportEndpointError({ route: endpoint.route, status: res.status, body: errorBody })`.
`endpoint.route` (e.g. `"POST /api/tasks/chain"`) is already in scope (`EndpointDef.route`, `define-endpoint.ts:12-14`). No status filtering here — the primitive stays domain-agnostic.

**MODIFY** `plugins/infra/plugins/endpoints/web/index.ts` — `export { registerEndpointErrorReporter } from "./internal/error-reporter";` (and the `EndpointErrorInfo` type).

### 2. New crashes sub-plugin that registers the reporter
**CREATE** `plugins/crashes/plugins/endpoint-errors/` (web-only), templated on `crashes/plugins/mutation-errors/`:
- `package.json` → `@singularity/plugin-crashes-endpoint-errors`, private, no deps.
- `web/index.ts` → plugin id `"crashes-endpoint-errors"`, `contributions: [Core.Root({ component: EndpointErrorReporter })]`.
- `web/components/endpoint-error-reporter.tsx` → `useEffect` registers the reporter, cleanup registers `null`:
  - **Filter (bug-shaped):** `status >= 500 || (status === 400 && isValidationBody(body))`, where `isValidationBody` checks `body.error === "Validation failed" || body.error === "Query validation failed"` **and** `Array.isArray(body.issues)`. This filter is load-bearing — it is what skips the page-editor's plain-text 400 control flow; do **not** loosen to bare `status === 400`.
  - **CrashReport** sent via `report(...)` from `@plugins/crashes/web`:
    - `source: "client-endpoint"`
    - `errorType` (the sole dedup discriminator — see note): 5xx → `EndpointError ${status} ${route}`; validation → `EndpointError ${status} ${route} (${issuePaths})` where `issuePaths` is the **sorted, de-duplicated** set of `issue.path.join(".")` joined by `", "`.
    - `message`: human summary — validation: `path: message` per issue; 5xx: stringified body.
    - `stack: null`, `url`/`userAgent` from `window`/`navigator` (as crash-reporter.tsx does).

> **Dedup note:** the crash fingerprint is `sha256(errorType + top-3 normalized stack frames)` (`crashes/shared/fingerprint.ts`). Every `EndpointError` throws from the same `fetch-endpoint.ts` line, so the stack is constant — `errorType` is the *only* discriminator. Encoding `route + status + sorted issue paths` yields one task per (route, status, field-set); repeated identical stale-bundle errors collapse and just bump `count`. Sorting + de-duping the issue paths is mandatory for a stable fingerprint.

### 3. Server: accept the new source
**MODIFY** `plugins/crashes/shared/types.ts` — add `| "client-endpoint"` to the `CrashSource` union.
**MODIFY** `plugins/crashes/server/internal/handle-report.ts` — add `"client-endpoint"` to `VALID_SOURCES` (otherwise every such report 400s at the gate).

### 4. Migrate the raw-fetch submit onto the typed endpoint
**MODIFY** `plugins/tasks/plugins/task-draft-form/web/internal/submit.ts` (lines 79-94) — replace the raw `fetch("/api/tasks/chain")` block with:
```ts
try {
  const json = await fetchEndpoint(createTaskChain, {}, { body });
  return { ok: true, taskIds: json.taskIds, launchedCount, totalCount };
} catch (err) {
  return { ok: false, errorMessage: `Submit failed: ${getEndpointErrorMessage(err)}`, launchedCount, totalCount };
}
```
Import `createTaskChain` from `@plugins/tasks/core`; `fetchEndpoint`/`getEndpointErrorMessage` from `@plugins/infra/plugins/endpoints/web`. The `SubmitOutcome` shape and the popover are untouched. The separate `uploadAttachment` call is out of scope (its own multipart endpoint).
**MODIFY** `plugins/infra/plugins/endpoints/check/typed-web-fetches.ts` — remove the now-obsolete `task-draft-form/web/internal/submit.ts` allowlist entry.

## Out of scope / unchanged
- `mutation-errors` watcher stays as-is (still toasts warnings for failed mutations). A bug-shaped mutation error will both toast **and** file a crash — intended; the subsystems are independent and both fire-and-forget.
- No recursion risk: `report()` uses raw `fetch("/api/crashes")`, not `fetchEndpoint`, so crash reporting never re-enters the chokepoint.
- The dead Build-button reload dot is tracked separately (task `task-1780409115480-29dir4`).

## Verification

1. `./equin build` (regenerates `web.generated.ts` so the new sub-plugin is registered via import analysis; satisfies `plugins-registry-in-sync`).
2. `./equin check --plugin-boundaries` and the `endpoints` typed-web-fetches check + typecheck pass.
3. **Repro the original bug shape:** with the app at `http://<worktree>.localhost:9000`, drive a follow-up task submit whose body is rejected (e.g. temporarily via devtools send a `kind:"child"` body, or point at a route that 400-validates). Confirm a crash task appears under the crashes meta-task with title `[crash] EndpointError 400 POST /api/tasks/chain (target.kind): …` and an `error`-variant notification.
4. **Dedup:** fire the same bad request 3×; confirm exactly **one** task, `count` = 3.
5. **Negative — control flow not flagged:** trigger the block editor "merge with no previous sibling" 400 (plain-text body) and confirm **no** crash task is filed. Trigger/confirm a 404 path produces no crash.
6. **5xx:** force a handler to 500 and confirm a crash task is filed.
7. `query_db` MCP to inspect the `crashes` table rows (fingerprint, count) for the worktree.

## Critical files
- `plugins/infra/plugins/endpoints/web/internal/fetch-endpoint.ts` (throw-site hook)
- `plugins/infra/plugins/endpoints/web/internal/error-reporter.ts` (new singleton)
- `plugins/primitives/plugins/error-boundary/web/reporter.ts` (precedent to mirror)
- `plugins/crashes/plugins/mutation-errors/web/index.ts` (sub-plugin template)
- `plugins/crashes/server/internal/handle-report.ts` (`VALID_SOURCES` gate)
- `plugins/crashes/shared/types.ts` (`CrashSource` union)
- `plugins/tasks/plugins/task-draft-form/web/internal/submit.ts` (raw-fetch migration)
- `plugins/infra/plugins/endpoints/check/typed-web-fetches.ts` (allowlist)
