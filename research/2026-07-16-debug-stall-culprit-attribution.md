# Stall reports name the wrong culprit — derive the label from the dominant stack

**Date:** 2026-07-16
**Status:** Proposed
**Scope:** `plugins/debug/plugins/{stall-monitor,health-monitor,trace/plugins/stall}`

## Context

A real `event-loop-stall` report filed this shape:

```
Event-loop stall 3329ms — is @ .../drizzle-orm/entity.js:7
culpritStack: "spawn ← listPanes ← listPanes ← list ← list ← collectLive ← ..."
topLeaves:  spawn [Unknown Executable]  46.7% (7/15 samples)
            is @ .../drizzle-orm/entity.js:7   6.7% (1/15)
```

The title names drizzle, which is present in **1 of 15 samples** and has nothing to
do with the freeze. The actual stall is `spawn`-rooted (46.7%), from the
conversations poller's 1s tick spawning `tmux`/`ps`. Anyone triaging this report by
its title investigates the wrong subsystem entirely — the report actively misleads.

`culpritStack` (the fingerprint) is correct throughout, so **dedup is fine**. Only
the human-readable label is wrong. But a perf alert whose title lies is worse than
no title: the whole point of stall-monitor (per its CLAUDE.md) is that the
Jul-7 incident had evidence naming the culprit verbatim while thousands of *victim*
reports buried it. A misleading title recreates exactly that failure mode.

### Root cause — two independent histograms

`aggregateTraces` (`health-monitor/server/internal/stall-profiler.ts:112-144`)
builds `leafCounts` and `stackCounts` as two **separately-sorted** maps, discarding
the association between a stack and its own leaf. `deriveCulprit`
(`stall-monitor/server/internal/culprit.ts:23-33`) then mixes them:

```ts
const culpritStack = section.topStacks[0]?.stack ?? "unknown";   // population A
const hotFrame =
  section.topLeaves.find((l) => l.key.includes(" @ "))?.key ??   // population B
  section.topLeaves[0]?.key ?? "event-loop stall";
```

Two distinct defects, one structural:

1. **Proximate:** the `" @ "` filter skips unattributed frames (`frameKey` at
   `stall-profiler.ts:88` emits `name [category]` for frames lacking `sourceURL`).
   `spawn` is native → skipped despite dominating → the scan walks the 1-sample ties
   and lands on whichever is attributable first. Arbitrary.
2. **Structural:** even with the filter fixed, `hotFrame` is drawn from a *different
   population* than `culpritStack`. The label can describe a minority stall while
   the fingerprint describes the dominant one. This is the bug class to eliminate.

The association **is** recoverable: the loop at `stall-profiler.ts:120` already has
both the innermost `frameKey` and the signature in hand, and just drops the link.

## Approach

Thread the leaf↔stack association through the evidence, then derive the label from
the **dominant stack's own frames** — coherent with the fingerprint by construction.

Label format: name *what* burned samples and *where* it was called from.

| Case | Label |
| --- | --- |
| Native leaf + attributable caller (this bug) | `spawn ← listPanes @ …/tmux-runtime.ts:499` |
| Native leaf + attributable caller (Jul-7) | `JSON.parse ← parseTranscript @ …/parse.ts:42` |
| Leaf already attributable (no redundant prefix) | `compileTemplate @ …/render.ts:88` |
| No attributable frame anywhere | `spawn [Unknown Executable]` |

The Jul-7 intent that motivated the original `" @ "` filter is **preserved** — that
case still surfaces `parseTranscript @ parse.ts:42` — while this bug's case now
names `listPanes` instead of drizzle.

`deriveCulprit` stays in stall-monitor (presentation lives with the alert plugin,
per its CLAUDE.md); the evidence plugin only gains the facts needed to derive it.

## Changes

### 1. `trace/plugins/stall/core/section.ts` — carry the frames

Add to `StallStackSchema`:

```ts
frames: z.array(z.string()).optional(),   // frameKeys, innermost → outermost
```

**Invariant (test it):** `frames[i]` is the resolved `frameKey` of the same frame
whose bare name is `stack.split(" ← ")[i]` — same slice, same order, same
`MAX_SIGNATURE_FRAMES` (40) cap.

`stack` stays untouched as the canonical fingerprint grain (names-only, line-free,
robust to edits). `frames` is additive evidence, never the dedup key.

Optional for back-compat: persisted traces predating this change parse unchanged
(`StallSectionSchema` validates trace detail in `stall/server/internal/class.ts`).

### 2. `health-monitor/server/internal/stall-profiler.ts` — stop dropping the link

In `aggregateTraces`, carry a representative frame-key list per signature:

```ts
const stackCounts = new Map<string, { count: number; frames: string[] }>();
...
const kept = frames.slice(0, MAX_SIGNATURE_FRAMES);          // slice ONCE
const leaf = frameKey(kept[0]);                              // leaf == frames[0]
const signature = kept.map((f) => (f.name && f.name.length > 0 ? f.name : "?")).join(" ← ");
const seen = stackCounts.get(signature);
if (seen) seen.count += 1;
else stackCounts.set(signature, { count: 1, frames: kept.map(frameKey) });
```

Generalize `topN` (currently `Map<string, number>`) over the value type with a
count extractor, so leaves pass `(n) => n` and stacks pass `(v) => v.count`.

Payload cost: ≤10 stacks × ≤40 keys. Bounded, deduped one row per fingerprint, and
traces are swept at 7 days — acceptable.

### 3. `stall-monitor/server/internal/culprit.ts` — derive from the dominant stack

```ts
export function deriveCulprit(section: StallSection): { culpritStack: string; hotFrame: string } {
  const top = section.topStacks[0];
  return {
    culpritStack: top?.stack ?? "unknown",
    hotFrame: hotFrameOf(top) ?? section.topLeaves[0]?.key ?? "event-loop stall",
  };
}
```

`hotFrameOf(top)`, walking **that stack's own** frames innermost → outermost:

- no `top` / no `frames` → `undefined` (fall through to the legacy `topLeaves[0]`)
- `frames[0]` is attributable (`includes(" @ ")`) → return it verbatim
- else first attributable frame `a` → `` `${leafName(frames[0])} ← ${a}` ``,
  where `leafName` strips the ` [category]` suffix (`spawn [Unknown Executable]` → `spawn`)
- no attributable frame at all → `frames[0]` as-is

Rewrite the file's header comment: the `" @ "`-scan rationale is now wrong, and the
"hottest attributable leaf" claim was never what the code did.

### 4. `stall-monitor/core/kinds.ts` — drop the dead `culprit` field

`StallPayloadSchema` declares `culprit`, set to the *same value* as `hotFrame` in
`record-stall.ts:47` and read **nowhere** (title uses `hotFrame`, summary uses
`hotFrame`, fingerprint uses `culpritStack`). Remove it from the schema and from
`record-stall.ts`. Zod strips unknown keys, so existing report rows still parse.

### 5. Docs

- `stall-monitor/CLAUDE.md` — retitle/rewrite the "Fingerprint on the STACK, not the
  leaf" section: keep the fingerprint rationale (still true and load-bearing), and
  add that the **label** is now derived from the dominant stack's frames rather than
  the independent `topLeaves` histogram. Record this bug as the motivating incident,
  as the file already does for Jul-7.
- `health-monitor/CLAUDE.md` — note that `topStacks` now carries per-stack
  `frames`, and the alignment invariant.

## Tests

`culprit.test.ts` (extend — existing Jul-7 assertion changes to the new format):

- **This bug's exact shape** (regression): `spawn`-rooted dominant stack with a cold
  1-sample drizzle leaf in `topLeaves` → hotFrame names `listPanes`, and asserts it
  does **not** contain `drizzle`.
- Jul-7 shape with `frames` → `JSON.parse ← parseTranscript @ …/parse.ts:42`.
- Leaf already attributable → returned bare, no `←` prefix.
- Stack with no attributable frame → bare `spawn [Unknown Executable]`.
- Back-compat: `topStacks[0]` without `frames` → falls back to `topLeaves[0].key`.
- Empty section → unchanged `{ culpritStack: "unknown", hotFrame: "event-loop stall" }`.

`stall-profiler.test.ts` (extend):

- `frames[i]` aligns 1:1 with `stack.split(" ← ")[i]` for every top stack.
- `frames[0]` equals the leaf key counted in `topLeaves` for that trace.
- The 40-frame cap applies identically to both.

## Verification

1. `bun test plugins/debug/plugins/stall-monitor plugins/debug/plugins/health-monitor`
2. `./equin build` (regenerates the autogen doc blocks; `plugins-doc-in-sync`
   and `type-check` gate the schema change)
3. **End-to-end** — a genuine 3s freeze isn't reproducible on demand, so drive the
   real path with the real payload: a scratch script calling the exported
   `recordEventLoopStall(section, 3329, 3000)` with this report's actual histogram
   (15 samples, `spawn` 7/15, drizzle 1/15, `frames` reconstructed from
   `culpritStack`). That exercises `deriveCulprit` → `captureTrace` → `recordReport`
   → `renderTask` against the live DB.
4. Confirm via `query_db`: the new `event-loop-stall` row's `data->>'hotFrame'` names
   `listPanes`, `data->>'culpritStack'` is unchanged (fingerprint stability — it must
   dedupe onto the **same** row as the existing report, not fork a new one), and no
   `culprit` key remains.
5. Eyeball Debug → Reports: the `StallSummary` badge and task title read
   `spawn ← listPanes @ …` instead of the drizzle frame.

## Outcome (implemented 2026-07-16)

Landed as planned. Three deviations worth recording:

**The bug was systemic, not a one-off.** A survey of `main`'s persisted
`event-loop-stall` rows found the label disagreeing with its own `culpritStack` on
most of them — every one titled with a frame from an unrelated subsystem:

| `culpritStack` (correct) | title said (wrong) | count |
| --- | --- | --- |
| `spawn ← listPanes ← … ← collectLive` | `is @ drizzle-orm/entity.js:7` | 6 |
| `spawn ← classifyPaneMenu ← …` | `(anonymous) @ infra/…` | 3 |
| `appendFileSync ← appendEntryToDir ← …` | `readGateGauges @ infra/…` | 7 |
| `statSync ← rotateIfNeeded ← tick` | `diffKeyedFull @ framework/…` | 1 |

**The planned scratch-script e2e was infeasible.** `recordEventLoopStall` →
`captureTrace` reads `getConfig("trace")`, which throws outside the server's
config_v2 boot lifecycle — a standalone `bun` script cannot drive it. Replaced with
what actually carries the risk, both against real data:
`core/kinds.test.ts` pins the schema's back-compat surface to the **real legacy
row** (`report-1784080035284-d53jrq`), and `culprit.test.ts`'s regression pins the
label to this stall's **real histogram**.

The one seam left unguarded by a test is `aggregateTraces` → `deriveCulprit`:
`aggregateTraces` is not exported from health-monitor's barrel, so a cross-plugin
integration test would either breach the boundary rules or add API surface for a
test alone. The seam is instead held by the shared `StallStackSchema` contract and
the `frames[i]` ↔ `stack.split(" ← ")[i]` invariant, tested independently on both
sides.

**`frames` is one representative sample, not a canonical position.** `frame.line`
is the sample's *executing* line, not the function's declaration line — this
stall's own evidence carries both `is @ entity.js:7` and `is @ entity.js:18` for
the same `is`. So traces sharing a name-only signature can resolve to different
keys; the first trace's keys are kept. Good enough for the label (it only needs to
attribute the path to a subsystem), and documented as such at all three sites.

### Known consequence: existing rows keep their stale labels

`hotFrame` is **persisted**, not recomputed at render. The four mislabeled rows
above keep their wrong titles until the same stack stalls again and `recordReport`
overwrites `data`. Since the fingerprint (`culpritStack`) is unchanged, a recurrence
updates the existing row in place rather than forking a new one — so they self-heal
on next occurrence. No backfill was done; deleting the rows would also discard their
`count` history.

## Out of scope

The **underlying stall itself** — `plugins/conversations/server/internal/poller.ts:292`
runs a hand-rolled `setInterval` at `TICK_MS = 1000`, spawning `tmux list-panes` +
`ps -axo` (plus up to one `tmux capture-pane` per live pane, 5s-throttled) every
second. `Bun.spawn` is async, but the `spawn` syscall itself runs on the event loop
and gets expensive under host memory pressure — which fits the paging/duress work in
recent commits. It's also a direct violation of CLAUDE.md's no-polling rule, with no
documented exemption. **Worth a separate task** — this plan only makes the report
tell the truth about it.
