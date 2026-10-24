# The no-slack guard: verify the premise per width, and prove it against a real layout engine

## Context

The task filed against this guard says it tests
`getComputedStyle(root).flexGrow === "0"` — the declared value, which is `1`
because the bar declares `flex-1` on itself, so the test can never fail.

**That is no longer the code.** It was replaced (commits `5b29f7d61`,
`0090ed141`) by a direct question to the layout engine —
`widthFollowsContent()` in
[`plugins/primitives/plugins/adaptive-bar/web/internal/adaptive-bar.tsx`](../plugins/primitives/plugins/adaptive-bar/web/internal/adaptive-bar.tsx):
hide every occupant the row is currently holding, read the row again, put them
back. A bar that was *given* its width measures the same either way; a bar whose
host shrink-wraps to it measures its own content twice. No style proxy, no
ancestor walk, sound by construction. The task's headline complaint is closed.

Three things about it are not.

1. **It is asked once, at mount** (`slackCheckedRef`, `adaptive-bar.tsx:497`).
   The premise it verifies is a property of the *host*, and a host can change
   after the bar mounts: a framing variant swaps, a wrapper's class flips, the
   contribution set arrives in later plugin waves, or a shrink-to-content
   ancestor whose width is floored by something else (a wider sibling, a
   `min-w-*`) stops being floored once the bar's own content grows past it.
   In every one of those the guard is already spent and the ratchet it exists
   to catch runs unobserved. Worse, the surrender re-arm's own termination
   argument (`MAX_SURRENDERS`, `web/internal/diagnostics.ts:190-207`) explicitly
   rests on the premise having been verified — "the cap is the backstop for the
   one shape where that reasoning fails — a shrink-to-content ancestor, which is
   `no-slack`'s business".

2. **Nothing exercises it under a real layout engine.** The only test that
   drives it (`web/__tests__/no-slack.test.tsx`) models the shrink-wrapping host
   through `AdaptiveBarMeasure`, the primitive's test-only measurement seam.
   Every layout-harness fixture the geometry gate renders hands the bar a proper
   growing cell, so no fixture has ever put the guard in front of real CSS.

3. **What the report tells a human is stale.** `plugins/reports/plugins/adaptive-bar`
   still describes `no-slack` as "the bar's root computed `flex-grow: 0` at its
   first laid-out pass" (payload schema comment, plugin `CLAUDE.md`, and the
   rendered task text in `server/internal/adaptive-bar-task.ts:63`), and tells
   the reader the bar did **"Nothing"** in response (`:104`) — when the actual
   remedy is `setDegraded(true)`: the ceiling, every occupant back in the row,
   CSS clipping. A report that misdescribes both the evidence and the remedy
   sends its reader looking for the wrong thing.

The intended outcome: the guard verifies its premise **per width** rather than
once per mount, a real browser proves it bites, and the report says what
actually happened.

## Design

### 1. The premise is verified per width, in the ratchet's own direction

Replace the one-shot `slackCheckedRef` with a verified-at-width ref plus a probe
budget:

```ts
/** The width the grow-cell premise was last VERIFIED at, and the probes spent. */
const slackVerifiedAtRef = useRef<number | null>(null);
const slackProbesRef = useRef(0);
```

The probe runs when the premise has never been verified, or when the row is now
**narrower** than the width it was last verified at (by more than
`HYSTERESIS_PX`, the same band the rest of the file uses for "a real resize"),
and there is budget left:

```ts
const verifiedAt = slackVerifiedAtRef.current;
const stale = verifiedAt === null || available < verifiedAt - HYSTERESIS_PX;
if (stale && slackProbesRef.current < MAX_SLACK_PROBES) { …existing probe… }
```

`slackProbesRef` is incremented and `slackVerifiedAtRef` set to `available`
**before** `widthFollowsContent` is called — the same re-entry discipline the
current flag already has, and what keeps a dev throw from re-arming itself.

Why **narrowing only**, and not every width change: an eviction can only ever
*reduce* what the row holds, so a content-following row can only be dragged
*narrower* by the bar's own decisions. Narrowing is the exact direction the fault
manifests in, and it is also the moment it first bites — a host whose
shrink-wrap is masked by a floor (a wider sibling, a `min-w-*`) reveals itself on
the first eviction that takes the content below that floor. A widening pane
costs nothing.

Why a **budget** (`MAX_SLACK_PROBES = 6`, declared beside `MAX_SURRENDERS` in
`web/internal/diagnostics.ts` with the reasoning): the probe is a forced reflow,
and a user dragging a pane narrower produces a narrowing every frame. Six is the mount verification plus enough
re-verifications to survive a short width sweep — the geometry gate steps
through several widths on one bar instance, and each narrowing legitimately
spends one. The trade is stated honestly rather
than hidden: after a long narrowing drag the bar is back to trusting its last
verification, which is exactly today's behaviour and strictly better than it.

Soundness is unchanged, and that is the point — the probe itself is definitive,
so the schedule can only ever change *when* a true answer is obtained, never
whether the answer is true. A false accusation remains impossible.

### 2. A real layout engine proves it bites — through the harness's own falsification vocabulary

A fixture whose bar simply *is* badly hosted cannot go in the catalog: the
Layout Lab renders that same catalog inside the app, where the report collector
is registered, so opening Debug → Layout Lab would file a real `no-slack` report
for a fixture that is working as designed — a permanent decoy in the alert
funnel the `debug` skill tells you to start from.

Note what a browser can and cannot see here. `import.meta.env.DEV` is compiled
to `false` in every built web artifact (`ARTIFACT_DEFINE`) and in the measurer
page (a production Vite build), so `failLoudly`'s throw exists only under
vitest: on the gate a fault is silent. The measurer page mounts no report-sink
collector either. **The proof therefore has to be geometric** — there is no page
error and no report to observe.

The harness already has the right vocabulary for "prove the guard bites": a
`falsification` invariant renders the fixture, applies a mutation to the painted
DOM, and asserts an invariant is **violated** (`core/types.ts`,
`web/internal/layout-geometry.test.ts:144`). Mutations are a gate-only concept —
the gallery never applies one — so the Lab keeps rendering a healthy bar and
files nothing.

Add one mutation kind and one fixture:

- **`{ kind: "shrinkWrapHost" }`** (`layout-harness/core/types.ts`, applied in
  `web/internal/entry.tsx`'s `applyMutation`): sets `width: max-content` on the
  element the fixture marked with `HOST_MARKER_ATTR` (a new exported constant,
  mirroring the existing `RAIL_MARKER_ATTR` convention), and throws if no marked
  element exists — the same loud failure `railOverride` already uses. Semantics,
  stated generically: *the host stops handing this primitive a width and starts
  taking its width from it*. Any measure-then-decide primitive can be falsified
  with it, not only this one.
- **Fixture `adaptive-bar/host-stops-giving-room`** in
  `plugins/primitives/plugins/adaptive-bar/fixtures/internal/adaptive-bar-fixtures.tsx`:
  an ordinary healthy bar inside a marked full-width host, sized so that at each
  swept width the bar evicts and still leaves more than `HYSTERESIS_PX` of slack
  in the row. Invariants: the usual `noOverlap`/`noClip` for the unmutated
  sweep, and **last** in the list
  `{ kind: "falsification", mutate: { kind: "shrinkWrapHost" }, expectViolated: { kind: "noClip" } }`.

Why `noClip` is the discriminator, precisely:

| after the mutation | with the guard | without it |
|---|---|---|
| the bar | faults, degrades to the ceiling: every occupant inline at rung 0 | keeps fitting from a width its own evictions produce |
| the row | content-wide, wider than the fixed `[data-geo="container"]` | ratchets itself empty, occupants leave into the body-portaled panel |
| `noClip` | **violated** — occupant boxes past the container's edge | satisfied — there is nothing left in the container to stick out |

So reverting either half of this plan (the probe, or its per-width schedule)
turns the falsification test into `falsification did not bite`. The measurer
settles by observation — it re-measures until two consecutive frames agree
(`measure-page.ts:150+`), explicitly for `ResizeObserver`-driven primitives — so
the mutation's several-pass response is waited out correctly.

The healthy negative control needs nothing new, and is stronger than it looks:
`adaptive-bar/actions-only` sweeps down to 60px and `adaptive-bar/rich-widgets`
to 220px, both in a `w-full` `Line`, both asserting `noClip`. A probe that
false-fired on either would latch the bar degraded, keep every occupant inline
at its widest, and blow `noClip` at the narrow end of those sweeps. That has
always been the "the guard does not accuse a healthy host" assertion; it was
simply never written down, and the fixtures file should now say so.

`check/index.ts`'s `SIG_GLOBS` already hashes each fixture contributor's plugin
root, so an edit to the primitive re-runs the gate.

### 3. The report says what happened

In `plugins/reports/plugins/adaptive-bar`: replace the `flex-grow: 0` account of
`no-slack` with what the guard actually does (hide the row's occupants, re-read
the row, restore — the width moved with the content), in the payload-schema
comment, the plugin `CLAUDE.md`, and `server/internal/adaptive-bar-task.ts`; and
correct `whatTheBarDid` from "Nothing" to the ceiling it actually commits
(everything back in the row, CSS clips, latched). Add the one new fact a reader
now needs: the premise is re-verified when the row narrows, so a report may
arrive well after mount and still name a host that broke later.

In the primitive's `CLAUDE.md`, correct the `no-slack` bullet (it says "once per
bar") and the claim that both engine-facing guards are "gated on a real layout
engine" — `row-overflow` is (`layoutMeasured`), `no-slack` is not: it is a
differential measurement through the seam, which is exactly why the jsdom suite
can drive it.

## Files

| file | change |
|---|---|
| `plugins/primitives/plugins/adaptive-bar/web/internal/adaptive-bar.tsx` | verified-at-width + budget refs replace `slackCheckedRef`; probe condition |
| `plugins/primitives/plugins/adaptive-bar/web/internal/diagnostics.ts` | `MAX_SLACK_PROBES` + its reasoning |
| `plugins/primitives/plugins/adaptive-bar/web/__tests__/no-slack.test.tsx` | late-onset detection, no-false-positive-on-narrowing, budget is bounded |
| `plugins/primitives/plugins/adaptive-bar/fixtures/internal/adaptive-bar-fixtures.tsx` | `adaptive-bar/host-stops-giving-room` |
| `plugins/primitives/plugins/css/plugins/layout-harness/core/types.ts` | `shrinkWrapHost` mutation + `HOST_MARKER_ATTR` |
| `plugins/primitives/plugins/css/plugins/layout-harness/web/internal/entry.tsx` | apply it |
| `plugins/primitives/plugins/css/plugins/layout-harness/CLAUDE.md` | document the mutation |
| `plugins/primitives/plugins/adaptive-bar/CLAUDE.md` | per-width verification; the two guards' gating, correctly |
| `plugins/reports/plugins/adaptive-bar/{core,server,CLAUDE.md}` | the stale `flex-grow: 0` account and the "Nothing" remedy |

## Verification

1. `./equin test plugins/primitives/plugins/adaptive-bar` — the new
   no-slack cases plus the existing 37.
2. `./equin check layout-geometry` — must pass with the new fixture; then
   temporarily neuter the re-probe (restore the one-shot flag) and confirm the
   falsification reports **did not bite**, then restore.
3. `./equin check` — boundaries, type-check, doc/registry sync.
4. `./equin build`, then open `http://<worktree>.localhost:9000/debug/layout-lab`
   and confirm the new fixture renders as an ordinary healthy bar (no crash card,
   no clipping) — the Lab must not see the falsification.
5. `query_db` on the worktree: no `kind = 'adaptive-bar'` rows produced by
   ordinary use of the app or by opening the Lab.

## Out of scope

- The probe budget is a heuristic bound on a diagnostic, not a guarantee: a bar
  that survives four narrowings and *then* loses its slack is not detected. A
  cheaper always-on signal (comparing `available` against the row's own content
  width per pass) exists but is only suspicion, not proof, so it would have to
  trigger this same probe anyway — worth revisiting only if a real miss is
  observed.
- `putLadder` still stores a fresh `Required<ShrinkLadder>` per re-declaration
  (noted in the previous plan, still true).
