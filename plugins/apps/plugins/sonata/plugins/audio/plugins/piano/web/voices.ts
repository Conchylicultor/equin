import { assetMirrorUrl } from "@plugins/infra/plugins/asset-mirror/core";
import type {
  InstrumentVoices,
  ScheduledNote,
} from "@plugins/apps/plugins/sonata/plugins/audio/plugins/instruments/web";
import { sharedSampleLoader } from "@plugins/apps/plugins/sonata/plugins/audio/plugins/sample-loader/web";
import { PIANO_MIRROR_ID } from "../shared/mirror";

/**
 * Wrap smplr's `SplendidGrandPiano` (high-quality sampled acoustic grand) into
 * the Sonata `InstrumentVoices` contract.
 *
 * Samples are served same-origin via the asset-mirror primitive: smplr fetches
 * `<mirror>/<sample>.<format>`, the server lazily downloads each file from the
 * CDN on first request, caches it under `~/.equin/cache/asset-mirror/`, and serves it from
 * disk thereafter. So the piano needs network exactly once (first online play),
 * then sounds fully offline — the browser never talks to the external CDN.
 * smplr's loader picks the format per browser (ogg on Chromium/Firefox, m4a on
 * Safari) and the mirror fetches whatever is requested, so all browsers work.
 *
 * Caveat: smplr swallows per-sample fetch failures (it `console.warn`s and skips
 * a non-200 sample rather than rejecting `ready`). So an offline-and-never-warmed
 * piano resolves `ready` but is silent; the loud failure signal is the mirror's
 * server-side 502 + log, not a client exception.
 *
 * smplr@0.26 API used here (verified against `smplr/dist/index.d.ts`):
 *  - factory `SplendidGrandPiano(ctx, { destination, baseUrl, loader })` —
 *    callable without `new`; `destination` routes output into the provided
 *    AudioNode; `baseUrl` overrides the default sample CDN; `loader` supplies a
 *    `SampleLoader` in place of the private one the instrument would build.
 *    `loader` is one of smplr's cross-instrument options rather than a piano
 *    option, so it is accepted by every instrument factory without appearing in
 *    `SplendidGrandPianoConfig`.
 *  - `piano.ready: Promise<void>` resolves when sample loading settles (`.load`
 *    is deprecated).
 *  - `piano.start({ note, velocity, time, duration })` — `note` accepts a MIDI
 *    number; `time`/`duration` are AudioContext seconds. Internally this routes
 *    through smplr's own Scheduler: notes whose `time` is beyond smplr's short
 *    lookahead window sit in a queue and are dispatched to the audio graph later.
 *  - `piano.stop()` (no target) stops only voices ALREADY dispatched to the
 *    audio graph. It does NOT clear smplr's internal scheduler queue — notes we
 *    pre-scheduled but smplr hasn't dispatched yet keep firing. Use
 *    `piano.scheduler.stop()` to flush that queue (see allOff).
 *  - `piano.dispose()` stops all voices and disposes the output channel.
 *
 * The engine builds one voice manager per TRACK, so a two-hand piano score
 * creates two of these. They share a `SampleLoader` (the `sample-loader` leaf)
 * so the sample set is downloaded and decoded once, not once per track. The
 * `scheduler` is deliberately NOT shared: `allOff` flushes it, and a shared one
 * would flush every other track's queued notes too.
 */
/** smplr's `SplendidGrandPiano` instance type, taken from the dynamically
 *  imported module so the module is only reached in type position (erased). */
type Piano = ReturnType<(typeof import("smplr"))["SplendidGrandPiano"]>;

export function createVoices(
  ctx: AudioContext,
  destination: AudioNode,
): InstrumentVoices {
  // `smplr` is imported DYNAMICALLY here (inside the factory body) rather than
  // as a top-level static import, so the ~heavy sample-engine library is
  // code-split OFF the eager plugin-boot wave: the barrel statically imports
  // this factory, but the factory only runs when the piano instrument is first
  // put in use (selected / default), which is when the chunk downloads. The
  // synchronous `InstrumentVoices` contract is preserved — the instance is
  // created behind the `loaded` promise every consumer already awaits before
  // scheduling, and the voice methods are safe no-ops until it settles.
  let piano: Piano | null = null;

  // After dispose() the smplr instance throws on any stop/start ("Cannot stop
  // voices on a disposed Smplr instance"). The panel drives this voice from two
  // independent effects whose cleanups run in mount order — dispose (voices
  // effect) before allOff (scheduling effect) — so allOff is *expected* to land
  // on an already-disposed instance on unmount and instrument-switch. Make the
  // contract robust to that ordering: once disposed, all voice methods are safe
  // no-ops (there are no voices left to stop or notes worth scheduling). The
  // same guard also covers the pre-load window (`piano` still null): a method
  // called before the smplr chunk resolves has no instance to act on yet.
  let disposed = false;

  // The shared loader is awaited ALONGSIDE the chunk rather than after it, so
  // this factory still has exactly one point at which the outside world lands —
  // and therefore still needs exactly one `disposed` re-check. (Both promises
  // resolve from the same module anyway: `sharedSampleLoader` reaches `smplr`
  // through the same dynamic import.)
  const loaded = Promise.all([import("smplr"), sharedSampleLoader(ctx)]).then(
    ([{ SplendidGrandPiano }, loader]) => {
      // Disposed before the chunk landed (fast unmount / instrument-switch): skip
      // instantiation entirely — there is nothing to sound or tear down.
      if (disposed) return;
      piano = SplendidGrandPiano(ctx, {
        destination,
        // Same-origin mirror instead of smplr's default CDN. smplr appends
        // `/<sample>.<format>` and URL-encodes it, so the mirror receives a
        // well-formed path; `formats` is left at smplr's default ["ogg","m4a"].
        baseUrl: assetMirrorUrl(PIANO_MIRROR_ID),
        // Shared per AudioContext: the sample set is fetched and decoded once
        // however many piano tracks the score has.
        loader,
      });
      return piano.ready;
    },
  );

  return {
    loaded,
    schedule({ pitch, velocity, when, duration }: ScheduledNote): void {
      if (disposed || !piano) return;
      piano.start({ note: pitch, velocity, time: when, duration });
    },
    play(pitch: number, velocity: number): () => void {
      if (disposed || !piano) return () => {};
      const stop = piano.start({ note: pitch, velocity });
      return () => {
        if (!disposed) stop();
      };
    },
    allOff(): void {
      if (disposed || !piano) return;
      // Two layers must be silenced: piano.stop() halts voices already on the
      // audio graph, and piano.scheduler.stop() flushes notes still queued in
      // smplr's internal lookahead (the engine pre-schedules ~1.5s ahead, so
      // without this they'd keep firing for up to a second after pause — the
      // "huge latency"). The next schedule() call re-arms smplr's poll loop, so
      // resume is unaffected; the scheduler is private to this instrument.
      piano.stop();
      piano.scheduler.stop();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      piano?.dispose();
    },
  };
}
