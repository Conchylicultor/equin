# Layout-geometry failure markers: one constant per signature, no kind list

## Context

`check/classify.ts` decides whether a failed `layout-geometry` run is a real
geometry regression (fatal) or an environmental flake (inconclusive, non-fatal,
no pass marker written). It recognises a real oracle violation by matching the
invariant's `kind` at the start of a line:

```ts
new RegExp(`^(${ORACLE_INVARIANT_KINDS.join("|")}):`, "m")
```

Two things are wrong with that, and the second is worse than the first.

**1. The list drifts silently.** `ORACLE_INVARIANT_KINDS` is hand-written, and
the guard meant to protect it (`check/index.test.ts`'s "invariant-kind allowlist
matches oracle.ts's emitted kinds") compares it against a *second* hand-written
literal inside the test. Both are edited independently of the `GeometryInvariant`
union in `core/types.ts`, so the dangerous direction is unguarded: add a kind to
the union and `evaluateInvariant`, forget `ORACLE_INVARIANT_KINDS`, and both
lists stay stale together, agree with each other, and the test passes. Hit for
real while adding `truncatesTogether`; caught only by a prose sentence in the
plugin's `CLAUDE.md` — rung 5.

**2. The regex does not match real output, so the list being complete would not
have helped anyway.** `bun:test` prints a thrown error as `error: <message>`, so
the transcript line is `error: noOverlap: at width 320px, …` — the `^` anchor
never lines up. Verified live: running `bun test` on a file that throws the exact
shape `layout-geometry.test.ts:179` produces, then testing the anchored regex
against the captured output, gives **no match**. Feeding a transcript that
carries a genuine violation *and* a genuine bun hook timeout through the real
`classifyFailure` returns **`inconclusive`** — a real geometry regression waved
through as environmental, which is precisely the failure the whole file exists to
prevent.

The repo's own regression test for this (`ORACLE_FAILURE_WITH_TIMEOUT_NOISE`,
"oracle violation wins over timeout noise → fatal") passes for the wrong reason:
its noise line ("mentioning a timeout here") matches no environmental signature
either, so `classifyFailure` falls through to the `ambiguous → fatal` default and
lands on the right answer by luck. The fatal branch it claims to exercise is
never taken.

**And the anchor cannot simply be dropped.** bun also prints the failing test's
*name*: `(fail) badge/long > noOverlap`. An unanchored kind-name match would make
every timeout inside a fixture `describe` fatal, destroying the environmental
path. A list of kind names is fundamentally unable to tell "the test named
`noOverlap` timed out" from "`noOverlap` was violated".

**Intended outcome.** The suite stamps each of its three failure classes with a
shared marker constant that only ever appears when that failure really happened;
the classifier matches those constants as plain substrings. `ORACLE_INVARIANT_KINDS`
and both hand-written lists are deleted. A new `GeometryInvariant` kind then needs
**no classifier edit at all** — rung 1, the concept removed rather than guarded —
and the misclassification above is cured as a side effect.

## Where the markers live, and why

`core/`. It is the only runtime both ends of the subprocess boundary can reach:
the suite is `web/internal/layout-geometry.test.ts` (web runtime, may import
`web` / `core` / `shared`), the classifier is `check/classify.ts` (node). This is
the same reasoning `core/types.ts` already gives for `HOST_MARKER_ATTR` — a
constant "authored by opposite sides" belongs in core.

Mirror `plugins/config_v2/core/internal/review-marker.ts` byte-for-byte in shape:
it is the identical pattern (a marker constant plus its helper, in
`core/internal/`, re-exported from the barrel, with a doc comment saying both
ends of a gate need it and neither may re-spell it).

## The change

### 1. New leaf: `core/internal/failure-markers.ts`

Zero imports, so `check/classify.ts` can import it with no runtime graph at all.
Three markers and three minting helpers:

```ts
/** The suite throws this when the ORACLE reports a violation. Matched by
 *  check/classify.ts as a FATAL signature. Both ends read this constant, so a
 *  new GeometryInvariant kind needs no classifier edit — there is no list. */
export const GEOMETRY_VIOLATION_MARKER = "layout-geometry invariant violated:";
export const FALSIFICATION_NOT_BITING_MARKER = "falsification did not bite:";
export const FIXTURE_PAGE_ERROR_MARKER = "fixture page error:";

export function geometryViolationError(detail: string): Error { … }
export function falsificationDidNotBiteError(detail: string): Error { … }
export function fixturePageError(detail: string): Error { … }
```

Each helper returns `new Error(\`${MARKER} ${detail}\`)`. Helpers rather than bare
constants because *minting* is what makes the marker unforgettable: the caller
builds its message and cannot construct the error without the stamp.

Re-export all six from `core/index.ts` — the suite imports through the
`@plugins/…/layout-harness/core` alias barrel, as it already does for
`evaluateInvariant` / `loadFixtures`. The autogenerated reference block in the
plugin's `CLAUDE.md` picks them up on the next `./equin build`.

### 2. `web/internal/layout-geometry.test.ts` — three throw sites

- line ~179: `if (!r.ok) throw new Error(r.detail);` → `throw geometryViolationError(r.detail);`
  (**the only path by which an oracle `detail` ever reaches stdout/stderr** —
  `evaluateInvariant`'s other call site, the falsification case at ~163, reads
  only `r.ok` and never prints `detail`; `core/oracle.test.ts` is a separate
  suite the check never spawns. So this one line closes the false-inconclusive
  direction completely.)
- `throwOnPageErrors` (~101): build the message, throw via `fixturePageError`.
  Its doc comment's "Keep the two in step if the wording changes" becomes
  untrue and is deleted — there is one string now.
- the falsification guard (~168): throw via `falsificationDidNotBiteError`.

### 3. `check/classify.ts` — delete the list

- Delete `ORACLE_INVARIANT_KINDS` and the anchored `RegExp`.
- `import { … } from "../core/internal/failure-markers";` — relative, matching
  the repo-wide convention that a `check/` file reaches its own plugin's `core/`
  relatively and reserves `@plugins/…` for cross-plugin imports
  (`config_v2/check/overrides-authored.ts`, `infra/plugins/paths/check/index.ts`,
  and ~13 others). Importing the leaf rather than `../core` keeps classify's
  runtime graph empty.
- Fatal detection becomes: any of the three markers present as a **substring**
  (`fullOutput.includes(m)`) — immune to bun's `error: ` prefix, indentation and
  wrapping — plus the existing `/\bAssertionError\b/` regex. Ordering and the
  "fatal wins on overlap / ambiguous → fatal" policy are unchanged.

A false fatal now requires the literal marker sentence to appear without a real
throw. bun's stack echo prints the *source* line (`throw geometryViolationError(…)`),
which does not contain the marker text — only the interpolated runtime value
does. And fatal is the safe direction the file already commits to.

### 4. `check/index.test.ts` — test the branch that was never taken

- Delete the "invariant-kind allowlist matches oracle.ts's emitted kinds" test
  (it guarded a list that no longer exists).
- Replace "every oracle invariant kind → fatal" with one oracle-violation test
  built from `GEOMETRY_VIOLATION_MARKER`, in the shape bun really prints
  (`error: <marker> noOverlap: at width 320px, …`).
- **The regression test that fails today**: a transcript carrying that violation
  line *and* a real bun hook timeout (`^ a beforeEach/afterEach hook timed out
  for this test.`) must be `fatal`. Write this one first and watch it fail
  against the current `classify.ts` — that is the red-green proof.
- **The test that keeps the environmental path honest**: a transcript whose only
  invariant-kind mention is bun's own name line (`(fail) badge/long > noOverlap`)
  plus a hook timeout, with no marker, must stay `inconclusive`. This is the case
  the `^` anchor existed for, and it must not regress.
- Rewrite the existing `FALSIFICATION_FAILURE`, `PAGE_ERROR_FAILURE` and
  `PAGE_ERROR_WITH_TIMEOUT_NOISE` fixtures to interpolate their constants so
  those fixtures cannot drift from the suite either.

### 5. Docs

`plugins/primitives/plugins/css/plugins/layout-harness/CLAUDE.md`:

- "## The oracle (`core/oracle.ts`)" — delete "A new kind MUST also be listed in
  `check/classify.ts`'s `ORACLE_INVARIANT_KINDS`, or a real regression is
  misclassified as an environmental timeout and passes non-fatally." Replace with
  a sentence stating a new kind needs no classifier edit, because the suite
  stamps every violation with one shared marker.
- The "environmental-timeout classification" bullet under consumer 2 — restate
  the fatal set as the three markers (minted in `core/internal/failure-markers.ts`,
  matched as substrings) plus `AssertionError`, and record *why* substring and
  not line-anchored: bun prefixes thrown errors with `error: `, and bun's own
  test-name line means a bare kind name cannot distinguish a violation from a
  timeout on a test that happens to be named after one.

## Files

| File | Change |
| --- | --- |
| `…/layout-harness/core/internal/failure-markers.ts` | **new** — 3 constants + 3 minting helpers, no imports |
| `…/layout-harness/core/index.ts` | re-export the six |
| `…/layout-harness/web/internal/layout-geometry.test.ts` | 3 throw sites go through the helpers |
| `…/layout-harness/check/classify.ts` | delete `ORACLE_INVARIANT_KINDS` + anchored regex; substring-match the markers |
| `…/layout-harness/check/index.test.ts` | delete the two-lists test; add the co-occurrence regression + name-line-stays-inconclusive tests |
| `…/layout-harness/CLAUDE.md` | drop the "MUST also be listed" instruction; document the marker contract |

Reference precedent, not modified: `plugins/config_v2/core/internal/review-marker.ts`.

## Verification

1. **Red first.** Add the co-occurrence test against unmodified `classify.ts` and
   run `./equin test plugins/primitives/plugins/css/plugins/layout-harness`
   — it must report `inconclusive` where `fatal` is expected. That failure *is*
   the bug. Then land the fix and re-run: green.
2. Same command covers `check/index.test.ts` and `core/oracle.test.ts`. Note it
   also picks up `web/internal/layout-geometry.test.ts`, which really launches
   Vite + Chromium (slow; the suite carries its own 120s budget) — expect several
   minutes and a green geometry sweep, proving the three rewritten throw sites
   still compile and the suite still passes end to end.
3. **Prove the marker survives a real subprocess.** Temporarily tighten one
   fixture invariant so it genuinely fails (e.g. drop an `epsilon` on a
   `noOverlap`), run `./equin check layout-geometry`, and confirm the
   result is reported as a hard failure (not `inconclusive`) and that the printed
   tail carries `layout-geometry invariant violated:`. Revert.
4. **Prove the compile side.** With the fix in, `./equin check type-check`
   must pass — `check/classify.ts` importing `../core/internal/failure-markers`
   sits inside the server-core program, which already includes both
   `**/plugins/*/check` and `**/plugins/*/core`.
5. `./equin build` (background) — runs checks, regenerates the plugin
   reference block in `CLAUDE.md` with the new core exports, and exercises the
   `layout-geometry` check on a real signature change.
