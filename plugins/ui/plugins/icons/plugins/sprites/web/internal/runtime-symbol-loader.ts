import type { GlyphKey } from "@plugins/ui/plugins/icons/core";
import type { GlyphEntry } from "@plugins/ui/plugins/icons/web";
import { MAX_RUNTIME_SYMBOLS_PER_READ } from "../../core";

/** One read's worth of wants: `names` sorted and duplicate-free, in one glyph key. */
export interface RuntimeSymbolBatch {
  /** The glyph chunk the batch lands as (unique per loader). */
  readonly chunkId: string;
  readonly key: GlyphKey;
  readonly names: readonly string[];
}

export interface RuntimeSymbolLoader {
  /** Want glyph `name` in `key` (a no-op once wanted). */
  request(entry: GlyphEntry): void;
  /** The batches not yet landed, oldest first — a new array on every change. */
  batches(): readonly RuntimeSymbolBatch[];
  subscribe(listener: () => void): () => void;
  /** Batch `chunkId` was provided to the sheet: stop reading it. */
  landed(chunkId: string): void;
  /** Every batch this loader ever made, oldest first — landed or not. */
  made(): readonly RuntimeSymbolBatch[];
}

/**
 * Turns `<Icon>`'s one-at-a-time wants into few reads: every want made before
 * the scheduled flush becomes one batch per glyph key (split past
 * {@link MAX_RUNTIME_SYMBOLS_PER_READ}), names sorted so the batch is one
 * content-addressed `icons.runtime-symbols` tuple; a name already wanted is
 * never batched again. The host reads `batches()` with `useLive` — a batch,
 * once made, never changes, so a later frame's wants open a new tuple and
 * leave the earlier ones alone — and calls `landed` once a batch's symbols
 * are in the sheet, so the tuples read at once are only the ones in flight.
 */
export function createRuntimeSymbolLoader(
  schedule: (flush: () => void) => void,
): RuntimeSymbolLoader {
  const requested = new Set<string>();
  let queued = new Map<GlyphKey, Set<string>>();
  let scheduled = false;
  let next = 0;
  let pending: readonly RuntimeSymbolBatch[] = [];
  const history: RuntimeSymbolBatch[] = [];
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const l of listeners) l();
  };

  const flush = () => {
    scheduled = false;
    const work = queued;
    queued = new Map();
    const made: RuntimeSymbolBatch[] = [];
    for (const [key, set] of work) {
      const names = [...set].sort();
      for (let i = 0; i < names.length; i += MAX_RUNTIME_SYMBOLS_PER_READ) {
        made.push({
          chunkId: `glyphs-${key}-${next++}`,
          key,
          names: names.slice(i, i + MAX_RUNTIME_SYMBOLS_PER_READ),
        });
      }
    }
    if (made.length === 0) return;
    history.push(...made);
    pending = [...pending, ...made];
    changed();
  };

  return {
    request({ key, name }) {
      const id = `${key} ${name}`;
      if (requested.has(id)) return;
      requested.add(id);
      let set = queued.get(key);
      if (!set) queued.set(key, (set = new Set()));
      set.add(name);
      if (!scheduled) {
        scheduled = true;
        schedule(flush);
      }
    },
    batches: () => pending,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    made: () => history,
    landed(chunkId) {
      if (!pending.some((b) => b.chunkId === chunkId)) return;
      pending = pending.filter((b) => b.chunkId !== chunkId);
      changed();
    },
  };
}
