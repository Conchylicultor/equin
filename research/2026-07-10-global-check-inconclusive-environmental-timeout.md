# Distinguish environmental check timeouts from real failures (`layout-geometry`)

## Context

The `layout-geometry` check (`plugins/primitives/plugins/css/plugins/layout-harness/check/index.ts`)
shells out to a `bun:test` suite whose `beforeAll` cold-builds a Vite fixtures
page and cold-launches headless Chromium. On an 18-core host that cold path
measures ~92s idle against a 120s hook budget (`bun test --timeout 120000`).
Under host contention — load avg ~20-28 from several concurrent worktree builds —
the cold path exceeds 120s and `bun:test` reports a hook timeout. The check
returns `{ ok: false }`, which flows into `runChecks` → `allOk = false` →
`StepResult{ id: "checks", success: false }` → the `failures.length > 0` gate in
`build.ts` (~line 1152) → `failBuild(...)` → `process.exit(1)` **before** the
deploy/gateway-registration steps. So an *environmental* timeout (not a geometry
regression) both (a) silently leaves the worktree un-deployed and (b) is
indistinguishable in the log from a real regression. Reproduced twice in one
session; both times the identical tree passed standalone.

**Root cause (structural, not instance-level):** the check result type collapses
two fundamentally different failures into one fatal state — a *geometry
regression* (deterministic, content-caused, reproduces, MUST block) and an
*environmental timeout* (host-load-caused, does NOT reproduce, MUST NOT block).
Bumping the timeout only moves the goalpost and makes a genuine hang take longer
to surface; it does not eliminate the class.

**Intended outcome:** an environmental timeout becomes a distinct, non-fatal,
**non-cached** `inconclusive` outcome. It is printed loudly, the build proceeds
to deploy, and because it is not cached the geometry is re-verified on the next
build. A real geometry regression stays fatal exactly as today.

**Decisions (confirmed with user):**
- On a classified environmental timeout the build **deploys anyway** and retries
  the geometry verification next build (accepting that this one build deploys
  without a fresh geometry check).
- **Scope: classifier only.** Do *not* touch `measure-page.ts`'s sub-timeouts and
  do *not* add an outer process kill-timeout in this change (noted as possible
  follow-ups below).

## Design

Add a third, opt-in `inconclusive` outcome to the generic `CheckResult`, teach
the runner to treat it as non-fatal + non-cached + distinctly printed, and have
the `layout-geometry` check classify its subprocess output into
`inconclusive` (pure environmental timeout) vs. the existing fatal failure.

Keeping the discriminant as `ok: false` (rather than a truthy third value) makes
the change **safe by default**: every existing `if (result.ok)` still treats an
inconclusive result as "not a pass," so it is never cached as a pass and never
counted as verified. Only the runner is taught to *soften* fatality when the
explicit `inconclusive` flag is set. The field is optional, so this is purely
additive — verified that only three files import the shared `CheckResult`
(`runner.ts`, `boundaries/core/check.ts`, `layout-harness/check/index.ts`) and
every other check declares its own structurally-identical local copy, so no other
file needs to change and there is no exhaustive `switch` on `CheckResult` anywhere
that tsc would force us to update.

## Changes

### 1. Type — `plugins/framework/plugins/tooling/core/types.ts` (lines 28-30)

Widen the fail variant with an optional flag:

```ts
export type CheckResult =
  | { ok: true }
  | { ok: false; message: string; hint?: string; inconclusive?: true };
```

Document that `inconclusive: true` means "the check could not determine
pass/fail for an environmental reason (host-load timeout, unlaunchable browser,
etc.) — it is non-fatal and is never cached, so it re-runs next time."

### 2. Runner — `plugins/framework/plugins/tooling/plugins/checks/core/runner.ts` (loop at 123-146)

Insert a middle branch between `if (result.ok)` and the hard-`FAIL` `else`:

- `else if (result.inconclusive)`:
  - does **not** set `allOk = false` (non-fatal),
  - emits a distinct line, e.g. `⚠ ${check.id} ... inconclusive — ${result.message}`,
  - reuses the same 100-line truncation + `hint` rendering the FAIL branch has
    (factor that block into a small shared local helper so the two branches can't
    drift),
- the existing final `else` stays the hard-fail path (`allOk = false`).

No change to the caching guard at line 101: it already records only
`result.ok === true`, and inconclusive is `ok: false`, so it is never cached —
this is what makes it retry next build. (Verified.)

Optional polish: track `let anyInconclusive` and, after the loop, print a short
non-alarming trailer distinct from the existing `!allOk` "STOP and report" banner
(lines 148-155, which correctly does NOT fire for inconclusive-only runs) — e.g.
"N check(s) inconclusive (environmental) — not cached, will retry next run."

`build.ts` and `check.ts` need **zero** changes: both derive fatality solely from
`runChecks`'s returned boolean, and `build-output.ts`'s `renderStepBlock` prints
all `StepResult.lines` regardless of success, so the `⚠` line surfaces in the
build console/log for free.

### 3. The check — `plugins/primitives/plugins/css/plugins/layout-harness/check/index.ts` (failure path 172-180)

Replace the tail-only failure return with classify-then-branch. Extract a pure
function `classifyFailure(fullOutput: string): "inconclusive" | "fatal"`.

**Critical: classify on the FULL, untruncated `stdout + stderr`**, not the 60-line
tail. A real assertion/oracle failure printed early in a long timeout-laced
transcript could otherwise be trimmed away and misclassified as environmental —
the single most dangerous failure mode. Only the human-facing `message` field
keeps using the truncated tail.

Classifier logic (fatal wins on any overlap; ambiguous → fatal):

1. **Fatal signatures — checked FIRST; force `"fatal"` regardless of any timeout
   wording present.** This suite fails a real regression by *throwing* (not
   `expect`), so the fatal set is a closed allowlist derived from the suite's
   actual throw-sites in `core/oracle.ts` + `web/internal/layout-geometry.test.ts`:
   - `/\bAssertionError\b/` — the two `expect()`-based tests (non-empty catalog;
     falsification's closing `expect(r.ok).toBe(false)`).
   - `/falsification did not bite:/`
   - `/^(noOverlap|noClip|leftPack|rigidIntegrity|pinnedRight|neverTruncatesWhenRoomy|truncationOnsetOrder):/m`
     — every `GeometryInvariant` kind, i.e. every way the oracle reports a real
     geometry violation.
2. **Environmental-timeout signatures — checked only if no fatal signature
   matched → `"inconclusive"`:**
   - `/timed out after \d+\s*ms/i` — bun:test's hook/test timeout wording
     (the literal `"... timed out after <n>ms."` is present in the bun binary;
     **implementer must confirm the exact live wording** — see Verification).
   - `/Timeout \d+ms exceeded/i` — generic Playwright timeout (covers
     `browserType.launch:`, `page.goto:`, `page.waitForFunction:`).
3. **Neither list matches** (Vite build error, OOM kill, Chromium segfault,
   unrecognized crash) → `"fatal"` (satisfies "ambiguous → fatal").

Return shape:
- `"inconclusive"` → `{ ok: false, inconclusive: true, message, hint }` and do
  **NOT** write the pass marker (so it retries next build). Message should read as
  environmental, e.g. "layout geometry suite timed out (environmental — cold
  Vite/Chromium under host load), not a geometry regression."
- `"fatal"` → the existing `{ ok: false, message, hint }` (marker not written
  either, as today).

Add a comment tying the fatal-signature list to `oracle.ts`'s `GeometryInvariant`
kinds so a future invariant addition is caught by proximity.

### 4. Unit test — `plugins/primitives/plugins/css/plugins/layout-harness/check/index.test.ts` (new, `bun:test`)

`classifyFailure` must be exported (or moved to a small sibling module) so it is
testable without launching a browser. Cases:
- synthetic bun hook-timeout sample → `inconclusive`
- synthetic Playwright launch-timeout sample → `inconclusive`
- synthetic `noOverlap: ...` oracle-failure sample **with the word "timeout"
  injected as noise elsewhere** → `fatal`
- synthetic `AssertionError` sample → `fatal`
- `falsification did not bite:` sample → `fatal`
- unrecognized garbage → `fatal`

Optionally assert the classifier's invariant-kind set equals `oracle.ts`'s
exported `GeometryInvariant` kinds so future drift fails loudly.

## Critical files

- `plugins/framework/plugins/tooling/core/types.ts` — widen `CheckResult`
- `plugins/framework/plugins/tooling/plugins/checks/core/runner.ts` — inconclusive branch (non-fatal, non-cached, distinct print)
- `plugins/primitives/plugins/css/plugins/layout-harness/check/index.ts` — `classifyFailure` + branch; don't write marker on inconclusive
- `plugins/primitives/plugins/css/plugins/layout-harness/check/index.test.ts` — new classifier unit test
- `plugins/primitives/plugins/css/plugins/layout-harness/core/oracle.ts` — source of the fatal invariant-kind allowlist (read-only reference)
- `plugins/primitives/plugins/css/plugins/layout-harness/CLAUDE.md` — add classification as a 4th robustness guard in the "when the marker IS absent" list

## Out of scope (possible follow-ups, per user)

- Raising `measure-page.ts`'s 30s `page.waitForFunction` / defaulted `page.goto`
  sub-timeouts toward ~100s (under the 120s backstop) to reduce premature kills.
- A defense-in-depth outer kill-timeout (~150s) on the spawned `bun test` child so
  a wedged Chromium can never hang the whole build; a forced-kill would classify
  as `inconclusive`.
- Filing an `inconclusive` occurrence into the reports system for observability.

## Verification

1. **Capture exact timeout wording (do before finalizing the regex):** in a
   worktree with `node_modules` populated and ideally a quiet host, run
   `bun test --timeout 1 plugins/primitives/plugins/css/plugins/layout-harness/web/internal/layout-geometry.test.ts`
   to force a `beforeAll` timeout; confirm the output matches
   `/timed out after \d+\s*ms/i` and adjust if the live wording differs.
2. **Classifier unit test:** `bun test plugins/primitives/plugins/css/plugins/layout-harness/check/index.test.ts` — all cases green.
3. **Real regression still blocks:** temporarily break a fixture/oracle expectation
   (or feed a `noOverlap:` sample) and confirm `classifyFailure` → `fatal` and the
   check returns a fatal `{ ok: false }` (build blocked, as today). Revert.
4. **Environmental path is non-fatal end-to-end:** simulate a timeout by pointing
   the check's spawn at `bun test --timeout 1 <suite>` (or inject a captured
   timeout transcript through `classifyFailure`), and confirm: the runner prints
   `⚠ ... inconclusive`, `runChecks` returns `true` (allOk), no `<sig>.pass`
   marker is written under `~/.singularity/layout-lab-cache/`, and a subsequent
   run re-invokes the suite (not cached).
5. **type-check:** `./equin check type-check` passes (additive `CheckResult`
   field, no exhaustiveness breaks).
6. **Full deploy:** `./equin build` completes through deploy/gateway
   registration; app reachable at `http://<worktree>.localhost:9000`.
