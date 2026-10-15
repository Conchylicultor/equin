import { useEffect, useMemo, useRef } from "react";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { useSession } from "@plugins/apps/plugins/sonata/plugins/session/web";
import type { SongSetting } from "@plugins/apps/plugins/sonata/plugins/document/web";
import {
  swingScore,
  type Score,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import {
  SonataAudio,
  type InstrumentVoices,
} from "@plugins/apps/plugins/sonata/plugins/audio/plugins/instruments/web";
import {
  useMutedTrackIds,
  useTrackInstrumentMap,
  useTrackVolumeMap,
} from "@plugins/apps/plugins/sonata/plugins/track-mixer/web";
import { startScheduling } from "../scheduler";
import { createOutputLatency } from "../output-latency";
import {
  DEFAULT_VOLUME,
  useAudioControls,
  useAudioState,
} from "../audio-store";

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
 * It hands the audible notes to `startScheduling`, which follows the session's
 * playback timeline — the one mapping from the audio clock to the music that
 * the visual cursor reads too — and schedules notes in a bounded look-ahead
 * window (re-arming itself via audio-clock events, never a JS timer /
 * polling), so playback start stays cheap regardless of Score size and sound
 * stays locked to the cursor through tempo changes, seeks and loops.
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
  const { score, isPlaying, timeline, registerClock } = useSession();

  // The latest (tempo-scaled) score, read by the scheduling effect for its
  // pedal lane without listing `score` (which changes on every tempo frame).
  const scoreRef = useLatestRef(score);

  // Muted tracks are dropped from the play-list before scheduling. We derive the
  // audible NOTE LIST (not a whole filtered score) keyed on `[score.notes,
  // mutedKey]`: `scaleTempo` preserves the `score.notes` array reference, so this
  // memo's identity is **stable across tempo changes** and only flips on a real
  // note/mute change. That stability is what lets the rebuild effect ignore tempo
  // churn (the scheduler re-times itself off the timeline) — so dragging the
  // speed wheel never tears down and re-attacks every ringing note.
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
    // Its latency is the output device's, so the cursor shows the music when
    // it is heard while the schedulers keep placing notes on `currentTime`.
    const latency = createOutputLatency(ctx);
    const unregisterClock = registerClock({
      now: () => ctx.currentTime,
      latency: () => latency.read(),
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

  // The context starts suspended until a gesture; playing resumes it (the play
  // button is itself one).
  useEffect(() => {
    if (isPlaying) void graph?.ctx.resume();
  }, [isPlaying, graph]);

  // --- Scheduling effect: follow the timeline with the audible notes. --------
  // The scheduler follows the session's timeline on its own: it restarts on a
  // play / seek / loop edit / medium jump, re-times on a tempo change without
  // cutting a ringing note, and silences on stop. So this effect re-runs only
  // when the NOTES it schedules change: `audibleNotes` (an edit or mute
  // toggle) and `inUseKey` (a track's instrument changed, or a track became
  // audible / silent). On an instrument change the rebuild is what awaits the
  // new instrument's `loaded` promise and gives a clean allOff → dispose →
  // create → re-attack cutover: the reconcile effect above is declared first,
  // so React runs this effect's cleanup (allOff) before that one's setup
  // (dispose), an ordering the instrument wrappers' `disposed` guard explicitly
  // tolerates.
  //
  // `inUseKey` rather than `trackInstrumentMap` itself: that map's identity is
  // re-minted whenever ANY persisted track-view field changes — a fader move
  // included — so listing it here would cut every ringing note each time one
  // track's level moved. Per-track levels are never read here at all: they
  // live on the strips' faders, downstream of everything this schedules.
  useEffect(() => {
    const ctx = graph?.ctx;
    if (!ctx) return;

    const channels = [...channelsRef.current.values()];
    // Route a track to its own channel strip, reading the ref live so it always
    // reflects the latest reconcile.
    const resolveVoices = (trackId: string): InstrumentVoices | undefined =>
      channelsRef.current.get(trackId)?.voices;

    let handle: { cancel(): void } | null = null;
    let cancelled = false;
    void (async () => {
      await Promise.all(channels.map((c) => c.voices.loaded));
      if (cancelled) return;
      // Joining the running timeline late (the load wait) drops the notes
      // that would now sound late, rather than bursting them out.
      // The notes as PERFORMED: a swung score's off-beats delayed
      // (`swingScore`, the identity when straight). Only the sound swings —
      // notation, the cursor and the loop bounds stay on the straight grid.
      const performed = swingScore({
        ...scoreRef.current,
        notes: audibleNotes,
      });
      handle = startScheduling(
        { notes: performed.notes, pedalEvents: performed.pedalEvents },
        timeline,
        resolveVoices,
        ctx,
      );
    })();

    return () => {
      cancelled = true;
      handle?.cancel();
      for (const channel of channels) channel.voices.allOff();
    };
  }, [graph, audibleNotes, inUseKey, timeline, scoreRef]);

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
