import { useEffect, useMemo, useRef } from "react";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { createSmoothClockModel } from "@plugins/packages/plugins/smooth-clock/core";
import {
  useCursorApi,
  useSession,
} from "@plugins/apps/plugins/sonata/plugins/session/web";
import type { SongSetting } from "@plugins/apps/plugins/sonata/plugins/document/web";
import type { Score } from "@plugins/apps/plugins/sonata/plugins/score/core";
import {
  SonataAudio,
  type InstrumentVoices,
} from "@plugins/apps/plugins/sonata/plugins/audio/plugins/instruments/web";
import {
  useMutedTrackIds,
  useTrackInstrumentMap,
  useTrackVolumeMap,
} from "@plugins/apps/plugins/sonata/plugins/track-mixer/web";
import {
  startScheduling,
  type LoopWindowBeats,
  type ScheduleHandle,
} from "../scheduler";
import {
  DEFAULT_VOLUME,
  useAudioControls,
  useAudioState,
} from "../audio-store";
import { scheduleOrigin, useDriftCorrection } from "../transport-sync";

/**
 * One track's channel strip: the track's own fader, and the voices feeding it.
 *
 * The `GainNode` belongs to the TRACK, not to the instrument — which is what
 * lets an instrument change swap `voices` in place (rebuilt into the same node)
 * while the fader position, and any glide still running on it, stay put.
 */
interface TrackChannel {
  /** The fader, connected to master. */
  gain: GainNode;
  /** The voice manager, created with `createVoices(ctx, gain)`. */
  voices: InstrumentVoices;
  /** The instrument id `voices` was built against — the swap trigger. */
  instrumentId: string;
}

/** Fader position of a track with no persisted level: the track as recorded. */
const UNITY_GAIN = 1;

/** The audible notes while the track view is not known: none. */
const NO_NOTES: Score["notes"] = [];

/**
 * A track's fader level. A strip exists only for a track the SETTLED track view
 * routes (`inUseKey` is empty while it is pending, so the reconcile effect has
 * torn every strip down), so a pending read here is a broken invariant, never a
 * level to stand in with.
 */
function levelOf(
  volumes: SongSetting<Map<string, number>>,
  trackId: string,
): number {
  if (volumes.kind !== "settled") {
    throw new Error(
      "audio engine: a channel strip was leveled before the track view settled",
    );
  }
  return volumes.value.get(trackId) ?? UNITY_GAIN;
}

/**
 * Time constant (seconds) of the fader glide. A level change is applied as a
 * short exponential approach rather than a step, because a step across a
 * sounding note is a waveform discontinuity — heard as a click.
 */
const FADER_GLIDE_SECONDS = 0.03;

// Separators for the content fingerprints below. Every id written into a
// fingerprint is `encodeURIComponent`-escaped, which escapes both of these, so a
// fingerprint round-trips exactly whatever an id contains. That exactness is
// what lets an effect keyed on a fingerprint read its payload back OUT of the
// fingerprint, instead of also listing a Map whose identity churns.
const ENTRY_SEP = "\n";
const FIELD_SEP = "|";

/** Sorted, joined fingerprint of a (trackId → instrumentId) set. */
function channelKey(pairs: Iterable<readonly [string, string]>): string {
  const entries: string[] = [];
  for (const [trackId, instrumentId] of pairs) {
    const track = encodeURIComponent(trackId);
    const instrument = encodeURIComponent(instrumentId);
    entries.push(`${track}${FIELD_SEP}${instrument}`);
  }
  return entries.sort().join(ENTRY_SEP);
}

/** Read a channel fingerprint back as trackId → instrumentId. */
function parseChannelKey(key: string): Map<string, string> {
  const map = new Map<string, string>();
  if (key === "") return map;
  for (const entry of key.split(ENTRY_SEP)) {
    const cut = entry.indexOf(FIELD_SEP);
    map.set(
      decodeURIComponent(entry.slice(0, cut)),
      decodeURIComponent(entry.slice(cut + 1)),
    );
  }
  return map;
}

/**
 * The headless Sonata audio engine — a `SonataSession.Effect`, mounted once per
 * playback session (`SonataPlayerScope`) and therefore **always mounted while
 * a song can play**, independent of which pane is active or whether the
 * player's section column is collapsed. It owns the Web Audio graph
 * (`AudioContext` + master gain), the per-track channel strips, and the
 * scheduling effect; it renders nothing.
 *
 * Previously this lived inside `AudioPanel` (a collapsible `Sonata.Section`), so
 * collapsing the panel unmounted the component and `ctx.close()`'d the
 * `AudioContext` mid-playback — killing all sound. Splitting the graph into this
 * always-mounted effect makes panel visibility purely cosmetic; the slider and
 * status line now talk to the engine through the per-surface `audio-store`
 * (provided above both via the `SonataSession.Provider` wrapper slot).
 *
 * On each `isPlaying → true` transition it captures one anchor (`ctx.currentTime`
 * + the cursor beat) and hands it to `startScheduling`, which schedules notes
 * against the Web Audio clock in a bounded look-ahead window (re-arming itself
 * via audio-clock events, never a JS timer / polling) so playback start stays
 * cheap regardless of Score size. Because both the visual rAF cursor and this
 * schedule anchor at the same play instant and derive time from `beatToSeconds`,
 * sound stays locked to the cursor through tempo changes.
 *
 * Instruments and levels are PER-TRACK: there is no global picker here — both
 * the instrument choice and the fader live in the Tracks panel. The engine keeps
 * one CHANNEL STRIP per audible track: a `GainNode` connected to master, fed by
 * a voice manager created into it, with every one of that track's notes routed
 * to it. Two tracks on the same instrument share nothing, and that is precisely
 * what makes a per-track fader possible — a voice manager shared between tracks
 * has a single output node, so there would be nowhere to put one. The strip set
 * derives live from `useTrackInstrumentMap()` + the audible score, so changing a
 * track's instrument mid-session loads the new timbre and re-schedules to play
 * it, in the same gain node, at the same level.
 */
export function AudioEngine() {
  const {
    score,
    isPlaying,
    seekEpoch,
    syncEpoch,
    readDriver,
    registerClock,
    loop,
  } = useSession();

  // Imperative per-surface cursor facade. Read through a ref inside the
  // scheduling effect so the effect's deps stay unchanged (the cursor is read
  // straight at the play instant, NOT a render input — see below). `cursor` is
  // stable (memoized on the store), so the ref simply mirrors it.
  const cursor = useCursorApi();
  const cursorRef = useLatestRef(cursor);

  // Live mirrors read inside effects without listing them as deps. `scoreRef`
  // gives every effect the latest (tempo-scaled) score even though the rebuild
  // effect intentionally does NOT depend on `score`; `isPlayingRef` lets the
  // tempo-keyed retime effect gate on play state without re-firing on play/pause.
  const scoreRef = useLatestRef(score);
  const isPlayingRef = useLatestRef(isPlaying);

  // The active A–B loop window (beats), or null when no enabled region is set.
  // Read through a ref inside the rebuild effect (the bounds are captured at the
  // play instant), while a stable signature drives the effect's deps so the
  // schedule rebuilds when the loop is toggled or its bounds move. A repeated
  // wrap at a *stable* loop never changes this signature, so the seamless
  // pre-scheduled loop (in `startScheduling`) is never torn down.
  const loopWindow: LoopWindowBeats | null =
    loop && loop.enabled && loop.end > loop.start
      ? { start: loop.start, end: loop.end }
      : null;
  const loopRef = useLatestRef(loopWindow);
  const loopKey = loopWindow ? `${loopWindow.start}:${loopWindow.end}` : "";

  // Muted tracks are dropped from the play-list before scheduling. We derive the
  // audible NOTE LIST (not a whole filtered score) keyed on `[score.notes,
  // mutedKey]`: `scaleTempo` preserves the `score.notes` array reference, so this
  // memo's identity is **stable across tempo changes** and only flips on a real
  // note/mute change. That stability is what lets the rebuild effect ignore tempo
  // churn (tempo is handled by the separate retime effect below) — so dragging the
  // speed wheel no longer tears down and re-attacks every ringing note.
  //
  // The key, not the Set, is the dep, and the filter rebuilds its set FROM the
  // key: `useMutedTrackIds()` re-mints its Set whenever ANY persisted track-view
  // field changes — a fader move included — so keying on the Set's identity would
  // hand the rebuild effect a fresh note array every time someone moved a level,
  // cutting every ringing note. Same hazard as tempo, same remedy.
  //
  // Until the open song's track view settles NOTHING is audible (`null` key):
  // a track the user muted must never sound for the round trip it takes to
  // learn so. The shell withholds the score meanwhile too; this is the engine's
  // own handling of the pending arm.
  const mutedIds = useMutedTrackIds();
  const mutedKey = useMemo(
    () =>
      // Pending or failed: nothing audible (a failed read is shown by the
      // player's score gate; the engine plays nothing it cannot vouch for).
      mutedIds.kind !== "settled"
        ? null
        : [...mutedIds.value].map(encodeURIComponent).sort().join(ENTRY_SEP),
    [mutedIds],
  );
  const audibleNotes = useMemo(() => {
    if (mutedKey === null) return NO_NOTES;
    if (mutedKey === "") return score.notes;
    const muted = new Set(mutedKey.split(ENTRY_SEP).map(decodeURIComponent));
    return score.notes.filter((n) => !muted.has(n.track));
  }, [score.notes, mutedKey]);

  // Resolved trackId → instrumentId (override ?? GM-program match ?? default),
  // live-state backed: it changes when someone picks a new instrument for a
  // track, which flows into the channel fingerprint below.
  const trackInstrumentMap = useTrackInstrumentMap();

  // Instruments are read generically — never names a contributor (collection
  // clean). A by-id map lets us look up a contribution's `createVoices`.
  const instruments = SonataAudio.Instrument.useContributions();
  const instrumentById = useMemo(
    () => new Map(instruments.map((inst) => [inst.id, inst] as const)),
    [instruments],
  );

  // The channel strips that SHOULD exist: one per track that still has audible
  // notes, paired with the instrument that track resolves to. A track whose notes
  // are all muted contributes nothing (so its strip is torn down). Folded into a
  // single sorted fingerprint so the effects below fire only when that SET
  // changes: not on every render, not on a level change (which re-mints
  // `trackInstrumentMap` with identical contents), not on a tempo change
  // (`audibleNotes` is reference-stable across those), and not when an unrelated
  // track's note tally shifts. The fingerprint is also the payload — the
  // reconcile effect reads the pairs back out of it — so no churning Map has to
  // sit in any dependency list.
  const inUseKey = useMemo(() => {
    // No strip while the track view is pending (nothing is audible either).
    if (trackInstrumentMap.kind !== "settled") return channelKey([]);
    const instrumentOf = trackInstrumentMap.value;
    const pairs: [string, string][] = [];
    const seen = new Set<string>();
    for (const n of audibleNotes) {
      if (seen.has(n.track)) continue;
      seen.add(n.track);
      const id = instrumentOf.get(n.track);
      if (id) pairs.push([n.track, id]);
    }
    return channelKey(pairs);
  }, [audibleNotes, trackInstrumentMap]);

  // Per-track fader positions (linear gain: 1 = unity, 0 = silent, 2 = +6 dB),
  // read through the latest-ref EVERYWHERE outside the fader effect below. Two
  // reasons, in increasing order of importance: the map is re-minted on every
  // persisted track-view change, and a level is not a reason to touch any audio
  // node's lifetime. Letting it into the reconcile effect's deps would churn
  // strips; letting it into the rebuild effect's deps would cancel and re-attack
  // every ringing note each time one fader moved — the exact regression the
  // tempo jog-wheel fix exists to prevent.
  const trackVolumes = useTrackVolumeMap();
  const trackVolumesRef = useLatestRef(trackVolumes);
  // Content fingerprint of the levels: a fresh Map identity every render would
  // re-fire the fader effect on every render. `null` while pending.
  const volumeKey = useMemo(
    () =>
      trackVolumes.kind !== "settled"
        ? null
        : [...trackVolumes.value]
            .map(
              ([trackId, v]) =>
                `${encodeURIComponent(trackId)}${FIELD_SEP}${v}`,
            )
            .sort()
            .join(ENTRY_SEP),
    [trackVolumes],
  );

  // Master volume is owned by the shared store (the panel slider writes it).
  const { volume, graph } = useAudioState();
  // Imperative writers for the engine's health slice. Memoized-stable on the
  // store handle, so listing it in effect deps below doesn't re-run effects.
  const { setStatus, setLoadError, setGraph } = useAudioControls();

  // --- Web Audio graph: AudioContext + master gain, owned in refs. ----------
  const ctxRef = useRef<AudioContext | null>(null);
  const masterRef = useRef<GainNode | null>(null);
  // One channel strip per audible track, keyed by trackId: its own fader into
  // master, feeding its own voice manager. Two tracks on the same instrument
  // share nothing — that separation is what gives each track a node to fade.
  const channelsRef = useRef<Map<string, TrackChannel>>(new Map());
  // The currently-running schedule, shared between the rebuild effect (which
  // creates/cancels it) and the retime effect (which re-times its tail on a
  // tempo-only change). Nulled on cancel so retime never lands on a dead handle.
  const handleRef = useRef<ScheduleHandle | null>(null);

  // Create the context eagerly on mount; it starts suspended until a gesture.
  useEffect(() => {
    const ctx = new AudioContext();
    const master = ctx.createGain();
    master.gain.value = DEFAULT_VOLUME;
    master.connect(ctx.destination);
    ctxRef.current = ctx;
    masterRef.current = master;

    // Publish the live graph so sibling per-surface audio effects (the metronome
    // reads `ctx`; the live player routes voices into `master`) can share the
    // SAME clock + output bus playback is anchored against.
    setGraph({ ctx, master });

    // Register the AudioContext clock as the transport's authoritative time
    // source, so the visual cursor reads the *same* clock the audio is
    // scheduled against (no drift, correct across tab backgrounding). Stable for
    // the whole session: `ctx.currentTime` is frozen while suspended and only
    // advances after `ctx.resume()` on play — exactly when the cursor reads it.
    //
    // Read SMOOTHED: `currentTime` advances once per rendered audio buffer, not
    // continuously, so successive animation frames read it 0 or 2 steps apart
    // and the cursor scrolls in jerks. The smooth clock extrapolates on the
    // wall clock between readings and slews (never jumps) toward each one, so
    // it stays within a buffer of the audio. While the context is not running
    // its time is frozen: hand that back raw and forget the fit, so a resume
    // snaps to the context instead of to a line that ran on without it.
    const smooth = createSmoothClockModel();
    const unregisterClock = registerClock({
      now: () => {
        if (ctx.state !== "running") {
          smooth.reset();
          return ctx.currentTime;
        }
        const perfMs = performance.now();
        smooth.observe(ctx.currentTime, perfMs, 1);
        return smooth.at(perfMs) ?? ctx.currentTime;
      },
    });

    // Belt-and-suspenders autoplay-gate unlock: the play button is itself a
    // gesture, but a one-time pointerdown resume covers any other entry point.
    const unlock = () => {
      void ctx.resume();
    };
    document.addEventListener("pointerdown", unlock, { once: true });

    const channels = channelsRef.current;
    return () => {
      unregisterClock();
      // Retract the published graph before tearing the context down so a sibling
      // never schedules onto a closing context.
      setGraph(null);
      document.removeEventListener("pointerdown", unlock);
      // Tear every strip down before the context: dispose the voices AND
      // disconnect the fader, then drop the map. That completeness is what lets
      // React StrictMode's second mount rebuild cleanly against the new context
      // instead of reusing nodes belonging to the closed one.
      for (const channel of channels.values()) {
        channel.voices.dispose();
        channel.gain.disconnect();
      }
      channels.clear();
      // Guard against React StrictMode's double invoke: only close once.
      if (ctx.state !== "closed") {
        void ctx.close();
      }
      ctxRef.current = null;
      masterRef.current = null;
    };
    // `registerClock` is stable (memoized in the provider) and `setGraph` is
    // memoized-stable on the store handle, so this effect still runs once:
    // create the AudioContext + register its clock + publish the graph on mount.
  }, [registerClock, setGraph]);

  // Master gain follows the volume slider live.
  useEffect(() => {
    if (masterRef.current) masterRef.current.gain.value = volume;
  }, [volume]);

  // --- Channel reconcile: one strip per audible track. -----------------------
  // Keyed on `inUseKey` (the stable (track → instrument) set fingerprint) so it
  // fires only when that set changes: build a strip for a newly-audible track,
  // re-voice a track whose instrument changed, tear down a track that dropped
  // out. Aggregate load errors loudly (mirror the prior per-instrument
  // `loaded.then(ok, err)` pattern). This effect is declared BEFORE the fader /
  // scheduling / status effects, so on any render where the set changes it
  // mutates the ref first — the later effects then read the up-to-date strips
  // without needing a separate version signal.
  useEffect(() => {
    const ctx = ctxRef.current;
    const master = masterRef.current;
    if (!ctx || !master) return;

    const channels = channelsRef.current;
    const inUse = parseChannelKey(inUseKey);
    const volumes = trackVolumesRef.current;
    let changed = false;
    let cancelled = false;

    // Surface a rejected load instead of spinning "Loading…" forever (and
    // leaving the rejection floating).
    const watchLoad = (voices: InstrumentVoices) => {
      void voices.loaded.then(
        () => {},
        (err: unknown) => {
          if (!cancelled) {
            setLoadError(err instanceof Error ? err.message : String(err));
          }
        },
      );
    };

    // Build the strips that are missing, and re-voice the ones whose track now
    // resolves to a different instrument.
    for (const [trackId, instrumentId] of inUse) {
      const existing = channels.get(trackId);
      if (existing?.instrumentId === instrumentId) continue;
      const contribution = instrumentById.get(instrumentId);
      // No registered contribution for this id: skip creating, exactly as
      // before. An existing strip keeps its now-stale voices rather than falling
      // silent on an id nothing can sound.
      if (!contribution) continue;

      if (existing) {
        // Instrument change: dispose the old voices and build the new ones into
        // the SAME GainNode. The fader belongs to the track, so its position —
        // and any glide still running on it — survives the new timbre.
        existing.voices.dispose();
        existing.voices = contribution.createVoices(ctx, existing.gain);
        existing.instrumentId = instrumentId;
        watchLoad(existing.voices);
      } else {
        const gain = ctx.createGain();
        // A plain write, not a ramp: nothing has ever played through this node,
        // so there is no discontinuity for a jump to make audible. Read through
        // the ref precisely so the levels do NOT become a dep of this effect.
        gain.gain.value = levelOf(volumes, trackId);
        gain.connect(master);
        const voices = contribution.createVoices(ctx, gain);
        channels.set(trackId, { gain, voices, instrumentId });
        watchLoad(voices);
      }
      changed = true;
    }

    // Tear down the strips of tracks that are no longer audible.
    for (const [trackId, channel] of channels) {
      if (inUse.has(trackId)) continue;
      channel.voices.dispose();
      channel.gain.disconnect();
      channels.delete(trackId);
      changed = true;
    }

    if (changed) setLoadError(null);

    return () => {
      cancelled = true;
    };
    // `inUseKey` carries the whole (track → instrument) set, so it is both the
    // change signal and the payload; `instrumentById` only changes when
    // contributions change; `setLoadError` is memoized-stable. `trackVolumesRef`
    // is a stable latest-ref — deliberately the ref and not the map, so moving a
    // fader never reconciles an audio node. All intentional deps.
  }, [inUseKey, instrumentById, setLoadError]);

  // --- Fader effect: apply live level changes to the strips that exist. ------
  // Separate from the reconcile effect on purpose: reconcile creates and
  // destroys audio nodes, and moving a level is not a reason to do either.
  // Keyed on the level fingerprint AND on `inUseKey`, so a strip created
  // mid-session picks up the current fader position on the very next commit
  // rather than waiting for the next drag. Neither key is read in the body —
  // they are the change signals; the levels themselves come through the stable
  // latest-ref, so a re-minted map with identical contents cannot re-fire this.
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const volumes = trackVolumesRef.current;
    for (const [trackId, channel] of channelsRef.current) {
      // A short glide rather than a step: the fader can move while the track is
      // sounding, and a discontinuous jump there is heard as a click.
      channel.gain.gain.setTargetAtTime(
        levelOf(volumes, trackId),
        ctx.currentTime,
        FADER_GLIDE_SECONDS,
      );
    }
  }, [volumeKey, inUseKey]);

  // --- Rebuild effect: anchor on play, schedule upfront, allOff on stop. ------
  // Re-runs on `seekEpoch` (a seek repositions the origin without changing the
  // notes), on `audibleNotes` (an edit or mute toggle), and on `inUseKey` (a
  // track's instrument changed, or a track became audible / silent) — each
  // legitimately needs the in-flight schedule cancelled (allOff) and rebuilt from
  // the current cursor. On an instrument change the rebuild is what awaits the
  // new instrument's `loaded` promise and gives a clean allOff → dispose →
  // create → re-attack cutover: the reconcile effect above is declared first, so
  // React runs this effect's cleanup (allOff) before that one's setup (dispose),
  // an ordering the instrument wrappers' `disposed` guard explicitly tolerates.
  //
  // `inUseKey` rather than `trackInstrumentMap` itself: that map's identity is
  // re-minted whenever ANY persisted track-view field changes — a fader move
  // included — so listing it here would cut every ringing note each time one
  // track's level moved. The fingerprint changes only when a track's resolved
  // instrument, or the audible track set, really does.
  //
  // It also deliberately does NOT depend on `score`: a tempo-only change keeps
  // `audibleNotes` referentially stable, so this effect doesn't run and no ringing
  // note is cut — the separate retime effect below re-times the tail instead.
  // Tempo is read live via `scoreRef` so a rebuild that DOES fire still uses the
  // current tempo. Per-track levels are never read here at all: they live on the
  // strips' faders, downstream of everything this effect schedules.
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;

    const channels = [...channelsRef.current.values()];

    if (!isPlaying) {
      for (const channel of channels) channel.voices.allOff();
      return;
    }

    void ctx.resume();

    // Capture the shared anchor synchronously at the play instant. The cursor is
    // read straight from the store (it's not a render input here) — a seek bumps
    // `seekEpoch`, re-running this effect so the read reflects the new position.
    const playAnchor = ctx.currentTime;
    const cursorBeat = cursorRef.current.getBeat();

    // Route a track to its own channel strip, reading the ref live so it always
    // reflects the latest reconcile.
    const resolveVoices = (trackId: string): InstrumentVoices | undefined =>
      channelsRef.current.get(trackId)?.voices;

    let handle: ScheduleHandle | null = null;
    let cancelled = false;
    void (async () => {
      await Promise.all(channels.map((c) => c.voices.loaded));
      if (cancelled) return;
      // Where to start. On the session's own clock: the cursor at the play
      // instant, which the visual transport anchored on too. With a driver (a
      // recording owns the position): wherever the medium is NOW, after the
      // load wait — or nothing at all while it is stalled; its resume bumps
      // `syncEpoch` and rebuilds from there.
      const reading = readDriver();
      const origin = scheduleOrigin(
        reading,
        cursorBeat,
        reading.kind === "internal" ? playAnchor : ctx.currentTime,
      );
      if (origin.kind === "stalled") return;
      // Compose the play-list score from the live tempo + the (mute-filtered)
      // audible notes. `score.notes` is reference-stable across tempo changes, so
      // this object is the only place tempo and notes are joined for scheduling.
      handle = startScheduling(
        { ...scoreRef.current, notes: audibleNotes },
        origin.fromBeat,
        origin.audioAnchor,
        resolveVoices,
        ctx,
        loopRef.current,
      );
      handleRef.current = handle;
    })();

    return () => {
      cancelled = true;
      handle?.cancel();
      if (handleRef.current === handle) handleRef.current = null;
      for (const channel of channels) channel.voices.allOff();
    };
    // `loopKey` (the enabled-loop bounds signature) is in deps so toggling the
    // loop or moving its bounds rebuilds from the current cursor with the new
    // window — a deliberate edit. A repeated wrap at a stable loop leaves `loopKey`
    // unchanged, so the pre-scheduled iterations in `startScheduling` keep playing
    // with no teardown (the seamless-loop fix). `loopRef` is a stable latest-ref.
    // `syncEpoch` re-anchors on a driver's stall / resume / own seek (an A–B
    // wrap is one, since a medium cannot fold a loop) and on a driver coming
    // or going; `readDriver` is stable.
  }, [
    isPlaying,
    audibleNotes,
    inUseKey,
    seekEpoch,
    syncEpoch,
    loopKey,
    readDriver,
  ]);

  // While a driver owns the transport, keep the running schedule on it: a slip
  // past ±40 ms re-anchors it without cutting a ringing note.
  useDriftCorrection(handleRef, graph?.ctx ?? null);

  // --- Retime effect: follow the speed jog-wheel without cutting any note. ----
  // Keyed on `score` (which changes only via tempo or content). A pure tempo drag
  // re-derives `score` ~60×/sec but leaves `audibleNotes` stable, so the rebuild
  // effect stays put while this re-times the running schedule's not-yet-dispatched
  // tail to the new tempo — leaving every sounding note untouched. We read the
  // audio clock and cursor beat back-to-back so the audio re-anchors to exactly
  // where the visual cursor just re-anchored (both derive from `ctx.currentTime`),
  // staying locked. No-op when paused, when no schedule is running, or on a content
  // change (the rebuild effect cleared `handleRef`, so this falls through and the
  // rebuild owns the reschedule).
  useEffect(() => {
    if (!isPlayingRef.current) return;
    const handle = handleRef.current;
    const ctx = ctxRef.current;
    if (!handle || !ctx) return;
    const audioAnchor = ctx.currentTime;
    // The scheduler re-derives its current position from the audio clock, so it
    // needs only the new tempo + the re-anchor instant (loop-aware internally).
    handle.retime(score, audioAnchor);
  }, [score]);

  // Aggregate status: "Loading…" until every live strip's voices are loaded, the
  // error if any failed, "Ready" otherwise. Keyed on `inUseKey` so it
  // re-evaluates whenever the strip set changes (the reconcile effect, declared
  // earlier, has already updated the ref by then). Published to the store as the
  // engine's health slice (no UI surface reads it yet).
  useEffect(() => {
    const channels = [...channelsRef.current.values()];
    if (channels.length === 0) {
      setStatus("empty");
      return;
    }
    setStatus("loading");
    let cancelled = false;
    void Promise.all(channels.map((c) => c.voices.loaded)).then(
      () => {
        if (!cancelled) setStatus("ready");
      },
      () => {
        // The load error is surfaced by the reconcile effect; leave status at
        // "loading" so the error line (not "Ready") shows.
      },
    );
    return () => {
      cancelled = true;
    };
    // `setStatus` is memoized-stable, so adding it doesn't change when this
    // re-evaluates (still on every strip-set change via `inUseKey`).
  }, [inUseKey, setStatus]);

  return null;
}
