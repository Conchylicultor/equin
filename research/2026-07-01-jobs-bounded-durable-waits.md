# Jobs: bounded durable waits by construction

**Date:** 2026-07-01
**Category:** infra/jobs (durable-wait engine layer)

## Context

Follow-up to `research/2026-07-01-workflows-user-input-timeout-lifecycle.md` (its
"Generalize bounded waits" out-of-scope item).

The `user-input` workflow step now passes `timeoutMs` to `ctx.waitFor`, but that
bound is enforced **only by that one executor's discipline**. The engine layer
(`ctx.waitFor`) treats `timeoutMs` as a bare optional number gated by
`if (opts.timeoutMs && opts.timeoutMs > 0)` (`step-ctx.ts:279-293`): omit it and
**no timeout racer is scheduled at all**, so the durable run suspends forever.

Any future suspending step type — or any `defineJob` calling `ctx.waitFor` — that
forgets `timeoutMs` reintroduces the exact bug just fixed. `ctx.waitFor` is the
only unbounded suspend primitive in the repo (`ctx.sleep` always schedules a
racer, so it always resumes; `ctx.step` doesn't suspend).

**Intended outcome:** an omitted `timeoutMs` can no longer silently mean "wait
forever." Every `ctx.waitFor` is bounded by construction via an engine-level
default + maximum cap, with a single **explicit, greppable opt-out** for the rare
genuinely-unbounded case.

## Design

### 1. Engine-level constants + resolver (jobs plugin)

`plugins/infra/plugins/jobs/server/internal/constants.ts` (the acyclic
"shared by registry.ts and worker.ts" module — the right home):

```ts
/** Safety-net default applied to any ctx.waitFor that omits timeoutMs. NOT a
 *  tuned business SLA — callers that care pass an explicit timeoutMs. It only
 *  guarantees an omitted wait still reaches a terminal state. */
export const DEFAULT_WAIT_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Hard structural ceiling: any explicit timeoutMs is clamped to this. Generous
 *  so it never clips legitimate business values (e.g. user-input's 30-day cap). */
export const MAX_WAIT_TIMEOUT_MS = 365 * 24 * 60 * 60 * 1000; // 1 year

/** Resolve a caller's waitFor timeout into a bounded ms value, or null for the
 *  explicit unbounded opt-out. unbounded → null (no racer); omitted → default;
 *  numeric → clamped to [1, MAX]. */
export function resolveWaitTimeoutMs(
  timeoutMs: number | undefined,
  unbounded: boolean | undefined,
): number | null {
  if (unbounded) return null;
  if (timeoutMs === undefined) return DEFAULT_WAIT_TIMEOUT_MS;
  return Math.min(Math.max(1, timeoutMs), MAX_WAIT_TIMEOUT_MS);
}
```

### 2. `waitFor` always arms a racer unless explicitly opted out

`plugins/infra/plugins/jobs/server/internal/step-ctx.ts` — replace the gate at
lines 279-293:

```ts
const resolvedTimeoutMs = resolveWaitTimeoutMs(opts.timeoutMs, opts.unbounded);
if (resolvedTimeoutMs !== null) {
  await init.scheduleResume(
    { /* ...RESUME_KEYS..., [RESUME_KEYS.timeout]: true */ },
    {
      jobKey: `jobs.resume.timeout:${init.workflowRunId}:${waitName}`,
      runAt: new Date(Date.now() + resolvedTimeoutMs),
    },
  );
}
```

**Teardown is already safe — no new code.** All racer-deletion paths are
unconditional and orphan-tolerant, confirmed by reading `resume-job.ts`,
`worker.ts`, `abort-run.ts`:
- Event-path resolve deletes `jobs.resume.timeout:<run>:<wait>` unconditionally
  (`resume-job.ts:113-118`) — already no-ops when no racer existed.
- `abortDurableRun` pattern-deletes `jobs.resume.timeout:<run>:%` (`abort-run.ts`).
- On normal completion the racer may briefly orphan; when it fires, `jobs.resume`
  finds a non-`pending` (or missing) wait row and no-ops (`resume-job.ts:54-62`).
- Singleton jobs reuse the same `jobKey`; graphile `addJob` replaces in place — no
  double-scheduling.

The only real cost: one extra `graphile_worker` row per previously-untimed wait
(currently zero such call sites).

### 3. Explicit opt-out via `unbounded?: true`

Chosen over overloading `timeoutMs: number | "never"` because:
- A named boolean is a far better audit surface — `grep -rn "unbounded: true"`
  enumerates every genuinely-unbounded wait; a string literal buried in a numeric
  field is not.
- It leaves `timeoutMs`'s type unchanged (no `number | "never"` union to
  propagate), so every existing reader of `timeoutMs: number` is untouched.
- The explicitness (a field you must deliberately set) is the safeguard: an
  *omitted* wait is now bounded; only a *deliberate* `unbounded: true` opts out.

Add `unbounded?: true` to the `waitFor` options in the **three** inline
duplications of the option shape:
- `step-ctx.ts` `WaitForOptions<T>` (lines 65-71) + `DurableCtx.waitFor` (138-141).
- `registry.ts` public `JobCtx.waitFor` inline opts (lines 54-66).
- **Consolidation (preferred):** have `registry.ts` import and reuse
  `WaitForOptions<T>` from `step-ctx.ts` instead of re-declaring the shape, *iff*
  no import cycle results (verify `step-ctx.ts` does not import `registry.ts`
  first; if it does, just add the field to both inline copies). Same plugin
  `internal/` dir, so a new edge is boundary-legal.

`plugins/conversations/server/internal/after-turn.ts` — its opts (`{ timeoutMs?,
name? }`, lines 7-15) need **no change**: `timeoutMs` type is unchanged, and its
passthrough already forwards `undefined` correctly (now → 7-day default instead of
forever, a strict improvement). No caller needs `unbounded`.

### 4. Not touched
- `ctx.sleep` — always schedules a racer; never hangs. Out of this bug class.
- No migration — pure application/type-level change; `_jobWaits` schema unchanged.
- `resolveWaitTimeoutMs`/constants stay **internal** (not exported from
  `server/index.ts`) — no consumer needs to introspect them, matching how other
  internal resolution helpers stay private.
- `user-input/core/expires.ts` stays as-is — its 7-day default / 30-day business
  cap is legitimate caller-space policy that sits under the engine ceiling.

## Files to modify
- `plugins/infra/plugins/jobs/server/internal/constants.ts` — add 2 constants + `resolveWaitTimeoutMs`.
- `plugins/infra/plugins/jobs/server/internal/step-ctx.ts` — use resolver, always-arm racer, add `unbounded?` to options type.
- `plugins/infra/plugins/jobs/server/internal/registry.ts` — add `unbounded?` to `JobCtx.waitFor` opts (consolidate to shared type if no cycle).
- New `plugins/infra/plugins/jobs/server/internal/constants.test.ts` — bun:test for `resolveWaitTimeoutMs`.

## Verification
- `bun test plugins/infra/plugins/jobs/server/internal/constants.test.ts` — cover:
  omitted → 7 days; `unbounded:true` → null; number under cap → itself; number
  over cap → MAX; 0/negative → 1.
- `./equin build` then `./equin check` (type-check, migrations-in-sync,
  boundaries all pass; expect no new migration).
- End-to-end (reuses the earlier task's harness): a `user-input` workflow with a
  ~1-minute `expiresAfter` still expires correctly (unchanged path, since it passes
  an explicit `timeoutMs`). A hypothetical `ctx.waitFor` with neither `timeoutMs`
  nor `unbounded` now shows a `jobs.resume.timeout:*` row scheduled ~7 days out
  (`query_db` on `graphile_worker._private_jobs`) instead of none.

## Follow-ups to file
- Optional lint rule flagging `ctx.waitFor` with `unbounded: true` for review
  visibility (low priority — the grep audit surface may suffice).
- If a real caller ever needs a bounded wait longer than `MAX_WAIT_TIMEOUT_MS`,
  raise the ceiling rather than reaching for `unbounded: true`.
