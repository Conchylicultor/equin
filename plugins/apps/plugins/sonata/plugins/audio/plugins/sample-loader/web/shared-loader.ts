// `smplr` types only. `import type` is fully erased at compile time, so naming
// these does NOT pull the heavy sample-engine chunk into this module — the
// library itself is reached only through the dynamic `import("smplr")` below,
// for the same reason the piano and soundfont wrappers import it dynamically:
// the chunk must stay off the eager plugin-boot wave.
import type {
  SampleLoader,
  SampleLoaderLoadOptions,
  SmplrPreset,
  Storage,
} from "smplr";

/**
 * One shared `SampleLoader` per `AudioContext`.
 *
 * Keyed WEAKLY on the context on purpose. The audio engine builds a fresh
 * `AudioContext` per mount (and React StrictMode builds two), so a module-level
 * singleton would either hand a stale loader to a new context — decoded
 * `AudioBuffer`s belong to the context that decoded them and cannot be played
 * through another one — or keep every context that ever existed alive through
 * the megabytes of samples cached inside its loader. A `WeakMap` gives each
 * context its own loader and lets the whole pair go when the context does.
 *
 * Within a context, one loader per sample SOURCE (its base path): a loader
 * fetches through the storage it was built with, and a source's storage only
 * reaches that source's files (`assetFetchOver`), so a piano and another
 * sampled instrument on one context each need their own.
 *
 * The PROMISE is cached rather than the resolved loader, so callers racing to
 * create the first loader for a context all join the one in-flight dynamic
 * import instead of each starting their own.
 */
const loaders = new WeakMap<
  BaseAudioContext,
  Map<string, Promise<SampleLoader>>
>();

/** Where an instrument's samples come from: a base path and the fetch reaching it. */
export interface SampleSource {
  /** The base the instrument's sample URLs are under. */
  readonly base: string;
  /** smplr's storage: fetches a URL under `base` over the host's transport. */
  readonly storage: Storage;
}

/**
 * The `SampleLoader` every smplr instrument built against `ctx` should be given
 * as its `loader` option.
 *
 * Why this exists: the engine builds one voice manager per TRACK, so a two-hand
 * piano score creates two `SplendidGrandPiano` instances. Left alone, each
 * builds its own private loader and fetches and decodes the entire sample set
 * for itself. smplr's loader caches decoded buffers by resolved sample URL, and
 * an instrument honours an injected one (`SmplrOptions.loader`, used verbatim in
 * place of the private one it would otherwise build), so one loader per context
 * collapses those N downloads and N decodes into one.
 */
export function sharedSampleLoader(
  ctx: BaseAudioContext,
  source: SampleSource,
): Promise<SampleLoader> {
  let bySource = loaders.get(ctx);
  if (!bySource) {
    bySource = new Map();
    loaders.set(ctx, bySource);
  }
  const existing = bySource.get(source.base);
  if (existing) return existing;

  // Renamed on destructure: smplr exports the factory and the interface it
  // produces under one name, and this module names the interface already.
  // The storage is how the samples are fetched — over the host's transport
  // (`InstrumentAssets`). Every instrument of one context is built by one host,
  // under one transport, so one source's first storage serves all its callers.
  const created = import("smplr").then(({ SampleLoader: createLoader }) =>
    withSharedLoads(createLoader(ctx, { storage: source.storage })),
  );
  bySource.set(source.base, created);
  return created;
}

/** One load in progress, and everyone who wants to hear about its progress. */
interface SharedLoad {
  readonly buffers: Promise<Map<string, AudioBuffer>>;
  readonly onProgress: Set<(loaded: number, total: number) => void>;
}

/**
 * Wrap a loader so that identical loads already IN FLIGHT are joined rather
 * than repeated.
 *
 * The URL cache inside smplr's loader is a plain `Map` of decoded buffers,
 * written only after a fetch settles — there is no in-flight entry to hit. That
 * is enough when the instruments are built at different times, and useless in
 * the case this plugin exists for: the engine creates every track's channel in
 * one reconcile pass, so two piano instances call `load()` in the same tick,
 * both miss the empty cache, and both fetch and decode the whole sample set.
 * Coalescing here is what makes the sharing actually pay.
 *
 * Two callers are only joined when the preset ALONE determines the result, i.e.
 * when neither injects pre-decoded buffers of its own. That exclusion is
 * load-bearing rather than cautious: smplr's `Soundfont` decodes its samples
 * itself and hands them in as `buffers`, under a preset whose `baseUrl` is the
 * empty string and whose sample names are bare note names — so two DIFFERENT
 * soundfont patches covering the same note range describe themselves
 * identically, and joining them would give one patch the other's sound.
 */
function withSharedLoads(loader: SampleLoader): SampleLoader {
  const inFlight = new Map<string, SharedLoad>();

  const load = (
    preset: SmplrPreset,
    onProgressOrOptions?:
      SampleLoaderLoadOptions | ((loaded: number, total: number) => void),
  ): Promise<Map<string, AudioBuffer>> => {
    // smplr still accepts a bare progress callback as the second argument
    // (deprecated in favour of the options object). Normalise once so the rest
    // of this function only ever sees the options form.
    const options =
      typeof onProgressOrOptions === "function"
        ? { onProgress: onProgressOrOptions }
        : onProgressOrOptions;

    // Caller-supplied buffers make the preset an incomplete description of the
    // result — see the note above. Pass such a load straight through.
    if (options?.buffers) return loader.load(preset, options);

    const key = sampleSetKey(preset);
    const joined = inFlight.get(key);
    if (joined) {
      if (options?.onProgress) joined.onProgress.add(options.onProgress);
      // Every joiner gets the SAME Map instance. That is safe because an
      // instrument only reads from the map it is handed (`buffers.get(sample)`);
      // a reversed-playback buffer, the one derived thing, is cached in a
      // separate per-instance map.
      return joined.buffers;
    }

    const onProgress = new Set<(loaded: number, total: number) => void>();
    if (options?.onProgress) onProgress.add(options.onProgress);
    const buffers = loader
      .load(preset, {
        // One underlying load, so one underlying progress stream, fanned out to
        // however many instruments are waiting on it. Each of them keeps its own
        // `loadProgress` accurate; a caller that joins late simply starts
        // hearing about progress from where the load has got to.
        onProgress: (loaded, total) => {
          for (const listener of onProgress) listener(loaded, total);
        },
      })
      // Drop the entry once it settles, whichever way it settles: on success the
      // loader's own URL cache serves any later identical load instantly, and on
      // failure a later caller must be free to try again rather than inherit a
      // rejection forever. The rejection itself is NOT swallowed — it reaches
      // every joined caller, whose `loaded` promise the engine already surfaces
      // as a load error.
      .finally(() => {
        inFlight.delete(key);
      });

    inFlight.set(key, { buffers, onProgress });
    return buffers;
  };

  return { load };
}

/**
 * A key identifying the set of sample URLs a preset resolves to, and therefore
 * the buffers a load of it produces: the base, the format candidates, any
 * name→path overrides, and the sample names the regions actually reference.
 *
 * Two presets with the same key resolve the same URLs, so one load's result is
 * exactly what the other would have produced. Anything else — velocity layers,
 * key ranges, loop points — shapes how the buffers are PLAYED, which stays with
 * each instrument and never reaches the loader.
 *
 * A pessimistic key is harmless: it only misses a chance to share and falls back
 * to the duplicate load we have today. So the `map` record is stringified as-is
 * rather than sorted — two instances of one instrument build it from the same
 * code path in the same order.
 */
function sampleSetKey(preset: SmplrPreset): string {
  const names = new Set<string>();
  for (const group of preset.groups) {
    for (const region of group.regions) names.add(region.sample);
  }
  return JSON.stringify([
    preset.samples.baseUrl,
    preset.samples.formats,
    preset.samples.map ?? null,
    [...names].sort(),
  ]);
}
