import type { IconifyJSON } from "@iconify/types";
import {
  hostStorage,
  type HostStorage,
  type HostStore,
} from "@plugins/framework/plugins/browser-server/plugins/host-storage/core";
import type {
  SavedSymbolName,
  StyleKey,
  SymbolSets,
} from "@plugins/ui/plugins/icons/core";
import {
  drawRuntimeSymbol,
  type RuntimeSymbolDrawerImpl,
} from "@plugins/ui/plugins/icons/plugins/sprites/server";
import { BUNDLED_SET } from "./bundled-set";

/** What this host's drawings are a function of: the bundled set alone. */
const IDENTITY = `${BUNDLED_SET.name}@${BUNDLED_SET.version} (weight 400 only)`;

/** The light set is not bundled: every light style resolves to its 400 drawing. */
const NO_LIGHT_SET: IconifyJSON = {
  prefix: "material-symbols-light",
  icons: {},
};

// What this host drew, in memory; and what its warm-up drew — the saved
// icons — written through to its storage too: it outlives a reload, and a
// build-time snapshot carries it, so a visitor's first visit draws the demo's
// icons without loading the set. A picker's grid is drawn in memory only, so
// the storage holds the saved names' drawings (and a stale set's are dropped
// when it opens), never the whole set.
interface Drawn {
  readonly store: HostStore<string>;
  readonly symbols: Map<string, string>;
}
const drawnByStorage = new WeakMap<HostStorage, Drawn>();

function drawnSymbols(): Drawn {
  const storage = hostStorage();
  let drawn = drawnByStorage.get(storage);
  if (drawn === undefined) {
    const store = storage.store<string>("icon-symbols", {
      // A symbol is markup: no instant in it.
      shiftTime: (symbol) => symbol,
    });
    const symbols = new Map<string, string>();
    for (const [key, symbol] of store.loaded) {
      if (key.startsWith(`${IDENTITY}\u0000`)) symbols.set(key, symbol);
      else store.delete(key);
    }
    drawn = { store, symbols };
    drawnByStorage.set(storage, drawn);
  }
  return drawn;
}

/** A drawing's key: the set it came from, its style and its name. */
function drawingKey(key: StyleKey, name: SavedSymbolName): string {
  return `${IDENTITY}\u0000${key}\u0000${name}`;
}

// The set, parsed once a drawing is missing, then kept: an icon picker asks
// for a batch per frame while it scrolls. A failed load is not kept.
let sets: Promise<SymbolSets> | null = null;

function bundledSets(): Promise<SymbolSets> {
  sets ??= BUNDLED_SET.load().then(
    (regular): SymbolSets => ({ regular, light: NO_LIGHT_SET }),
    (err: unknown) => {
      sets = null;
      throw err;
    },
  );
  return sets;
}

/**
 * `names`' drawings in style `key`: held ones from memory, the rest drawn from
 * the bundled set (loaded on the first miss) and held; with `persist`, every
 * drawing is also written to the host's storage.
 */
async function drawHeld(
  key: StyleKey,
  names: readonly SavedSymbolName[],
  persist: boolean,
): Promise<readonly string[]> {
  const { store, symbols } = drawnSymbols();
  const missing = names.filter((n) => !symbols.has(drawingKey(key, n)));
  if (missing.length > 0) {
    const loaded = await bundledSets();
    for (const name of missing) {
      symbols.set(drawingKey(key, name), drawRuntimeSymbol(loaded, key, name));
    }
  }
  return names.map((name) => {
    const at = drawingKey(key, name);
    const symbol = symbols.get(at);
    if (symbol === undefined) {
      throw new Error(`[icons] "${name}" was drawn, then lost`);
    }
    if (persist && !store.loaded.has(at)) store.put(at, symbol);
    return symbol;
  });
}

/**
 * A browser host's drawer: the bundled 400-weight set. A name or style
 * already drawn costs a map lookup; only a miss loads the set.
 */
export const bundledSymbolsDrawer: RuntimeSymbolDrawerImpl = {
  identity: IDENTITY,
  draw: (key, names) => drawHeld(key, names, false),
};

/**
 * Draw `names` in style `key` and keep the drawings in the host's storage —
 * the warm-up's, for the saved icons a reload (or a snapshot) must draw
 * without the set.
 */
export async function drawAndKeep(
  key: StyleKey,
  names: readonly SavedSymbolName[],
): Promise<void> {
  await drawHeld(key, names, true);
}
