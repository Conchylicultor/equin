# Sonata: crackle-free audio while scrubbing playback speed

## Context

Dragging the toolbar speed jog-wheel (`TempoWheel`) while a song is playing makes
the audio **buzz/crackle** ("grésiller"). A single discrete speed change is fine —
only a continuous drag triggers it.

**Root cause (confirmed).** The wheel calls `setTempoScale` ~60×/sec. Each call
re-derives `score` via `scaleTempo` (only `tempoMap` bpms are multiplied;
`score.notes` is reference-preserved by the `{...score, tempoMap}` spread). In the
audio engine, `audibleScore` is a `useMemo` over `[score, mutedIds]`, so it gets a
**new identity each tempo step**. The scheduling effect lists `audibleScore` in its
deps, so it **re-runs ~60×/sec**; its cleanup calls `manager.allOff()` →
`piano.stop()` + `piano.scheduler.stop()`, **cutting every currently-ringing note**
60×/sec. That amplitude-modulates the sustained samples into a buzz.

**Desired outcome (chosen by the user).** Live, crackle-free tracking: as the wheel
is dragged, **re-time upcoming notes** for the new tempo **without cutting notes
currently sounding** and **without double-triggering** notes already dispatched into
smplr's lookahead. A tempo change is purely a re-timing (note beats/identities are
preserved), so it must not go through the `allOff` + rebuild path that content / mute
/ seek changes legitimately need.

## Approach

Distinguish a **tempo-only re-time** from a **content/mute/seek rebuild**, and add an
imperative `retime` path to the running scheduler that rescales only the
not-yet-dispatched notes — never touching what is already sounding.

Two files change; blast radius is fully contained to them (grep-verified: nothing
else imports `startScheduling`/`ScheduleHandle` or references `audibleScore`).

### 1. `audio-engine.tsx` — split derivation + two effects

File: `plugins/apps/plugins/sonata/plugins/audio/plugins/engine/web/components/audio-engine.tsx`

- **Replace `audibleScore` (lines 62–68) with a tempo-stable `audibleNotes` memo:**
  ```ts
  const audibleNotes = useMemo(
    () => (mutedIds.size === 0
      ? score.notes
      : score.notes.filter((n) => !mutedIds.has(n.track))),
    [score.notes, mutedIds], // score.notes is ref-stable across tempo changes
  );
  ```
  Its identity now changes **only** on real note/mute changes, not on tempo changes.
- **Repoint `inUseIds` (lines 88–95)** to iterate `audibleNotes` instead of
  `audibleScore.notes` (required — `audibleScore` is being deleted). The reconcile
  effect's `inUseKey` already no-ops on tempo, so manager reconcile is unaffected.
- **Add a `scoreRef = useLatestRef(score)`** (so effects read the live tempo without
  depending on it) and **`handleRef = useRef<ScheduleHandle | null>(null)`**.
  Note: `useLatestRef` writes during render, so `scoreRef.current` is already the
  new-tempo score before any effect (layout or passive) runs in that commit.
- **Rebuild effect** (current scheduling effect, lines 222–265): deps become
  `[isPlaying, audibleNotes, trackInstrumentMap, seekEpoch]`. On a **pure tempo
  change none of these change**, so it does **not** re-run → **no `allOff` → no
  buzz**. Build the scheduler input from `{ ...scoreRef.current, notes: audibleNotes }`.
  In the async IIFE set `handleRef.current = handle` after the `await`. In cleanup:
  `cancelled = true; handle?.cancel(); if (handleRef.current === handle) handleRef.current = null;`
  then `allOff()` (so a later retime never lands on a stale/cancelled handle).
- **New retime effect**, keyed on `[score]`:
  ```ts
  useEffect(() => {
    if (!isPlayingRef.current || !handleRef.current) return;
    const ctx = ctxRef.current;
    if (!ctx) return;
    const audioAnchor = ctx.currentTime;          // read back-to-back so audio
    const fromBeat = cursorRef.current.getBeat();  // stays self-consistent & cursor-locked
    handleRef.current.retime(scoreRef.current, fromBeat, audioAnchor);
  }, [score]);
  ```
  Gate `isPlaying` via a ref (not deps) so play-start doesn't re-fire it. `retime`
  uses the passed score **only to rebuild the tempo index** — it must **not** re-read
  `notes` (the existing `pending[]` is already mute-filtered; re-filtering would be
  wrong) and must **not** re-read `ctx.currentTime` internally (would desync from
  `fromBeat`).

### 2. `scheduler.ts` — add `retime` to the running schedule

File: `plugins/apps/plugins/sonata/plugins/audio/plugins/engine/web/scheduler.ts`

- **Widen the local `pending[]` entry** (lines 47–56) to also retain `startBeat`
  (`n.start`) and `durationBeats` (`n.duration`). Do **not** widen the exported
  `ScheduledNote` (slots.ts) — the public `schedule({pitch,velocity,when,duration})`
  contract stays as-is.
- **Add `retime(tempoSource, newFromBeat, newAudioAnchor)`** to `ScheduleHandle`
  (interface lines 5–7; impl after line 86):
  - `if (cancelled) return;`
  - `const t = buildTempoIndex(tempoSource); const t0 = t.beatToSeconds(newFromBeat);`
  - One forward pass over the **un-dispatched tail** (`j` from current `i`):
    - If `pending[j].startBeat < newFromBeat` → it is behind the new cursor (already
      sounding or just passed): **drop it** — advance `i` past it and `continue`.
      **Do not clamp `when` to now** (that re-attacks the note — the exact artifact
      the original `n.start >= fromBeat` filter at line 46 prevents). Stop dropping
      once `startBeat >= newFromBeat` (the tail is `startBeat`-ascending).
    - Else recompute
      `pending[j].when = newAudioAnchor + t.beatToSeconds(startBeat) - t0` and
      `pending[j].duration = t.beatToSeconds(startBeat + durationBeats) - t.beatToSeconds(startBeat)`.
  - Notes already dispatched (`j < i`) keep their old `when` — left alone, **never
    cut**. The pump continues from `i` against the mutated `when`s, so **no
    double-trigger**. Rescaling the whole tail through one monotonic index preserves
    the ascending-`when` sort the pump relies on; the head (old tempo, `when <= now`)
    stays below the tail (new tempo, `when >= newAudioAnchor`), so the head/tail
    boundary is preserved too.

### 3. (Separate commit) tighten tracking latency

The buzz fix above works at **any** lookahead. Lowering it only shrinks the window of
already-handed-to-smplr notes that `retime` cannot reach, so the audio tracks the
wheel more tightly. As its **own commit** (bisectable if it regresses):

- `LOOKAHEAD_SEC: 1.5 → 0.25`, `REFILL_SEC: 0.75 → 0.10` (keep REFILL ≲ LOOKAHEAD/2;
  smplr's own ~200 ms scheduler is the second safety layer). Don't go below ~0.2.
- The one thing to actually **test, not reason about**: confirm the
  `ConstantSourceNode.onended` refill loop survives the faster cadence with the tab
  **backgrounded** (the reason it uses the audio clock instead of rAF).

## Why this is the clean design

- Each effect now has **honest deps**: rebuild on content, retime on tempo. No manual
  ref-diffing inside one overloaded effect.
- The control plane stays in **our** scheduler (where `i` is known), so we never fight
  smplr's opaque internal queue with `stopId`-based selective cancel.
- `scaleTempo` is **unchanged** — the fix leans only on its existing
  `notes`-reference-preserving spread.

## Critical files

- `plugins/apps/plugins/sonata/plugins/audio/plugins/engine/web/components/audio-engine.tsx`
- `plugins/apps/plugins/sonata/plugins/audio/plugins/engine/web/scheduler.ts`
- (reference, unchanged) `…/shell/web/context.tsx` (score memo + `useLayoutEffect`
  reanchor at line ~668; `registerClock` makes `ctx.currentTime` the transport clock),
  `…/score/core/tempo-index.ts` (`buildTempoIndex`), `…/audio/plugins/piano/web/voices.ts`
  (`allOff` = `piano.stop()` + `piano.scheduler.stop()`).

## Verification

Audio artifacts require **listening in the running app** (a headless test cannot hear
the buzz). After `./equin build`, open a song at
`http://<worktree>.localhost:9000/sonata/song/<id>`, press play, and:

1. **Drag the speed wheel** slowly and fast on a dense MIDI → **no buzz**; audio
   follows the tempo and stays locked to the visual cursor (within ~LOOKAHEAD).
2. **Mute a track mid-play** → rebuild fires once, no buzz.
3. **Seek mid-play** → audio jumps cleanly to the new position.
4. **Edge tempo changes**: at the very first beat (`fromBeat ≈ 0`) and near song end.
5. After the separate lookahead commit: **backgrounded-tab playback** with the reduced
   lookahead — confirm no dropouts.

No automated test covers the audible artifact; `./equin check` + `type-check`
must still pass for the refactor.
