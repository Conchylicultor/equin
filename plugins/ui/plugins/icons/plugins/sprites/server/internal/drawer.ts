import { defineHostService } from "@plugins/framework/plugins/server-core/core";
import {
  buildSymbol,
  resolveSymbol,
  runtimeSymbolId,
  type SavedSymbolName,
  type StyleKey,
  type SymbolSets,
  wrapSprite,
} from "@plugins/ui/plugins/icons/core";
import { allSavedSymbolNames } from "@plugins/ui/plugins/icons/plugins/saved-names/core";
import { sha256Hex } from "@plugins/packages/plugins/string-hash/core";

/**
 * How a host draws saved (runtime) symbols: from the icon sets installed on
 * the computer (the desktop, `sprites#machine`), or from a set bundled with
 * the page (a browser host, `plugins/bundled-symbols`).
 */
export interface RuntimeSymbolDrawerImpl {
  /**
   * What this drawer's drawings are a function of — the set(s) it draws from
   * and their versions — folded into {@link symbolsHash}, so a tab never
   * reads one host's drawings under another's address.
   */
  readonly identity: string;
  /**
   * One `<symbol id="msr-<key>-<name>">` per name, in order: the style's own
   * drawing, or the nearest style that has the name (`resolveSymbolStyle`)
   * among the sets this drawer holds. Every name is a saved symbol name.
   */
  draw(
    key: StyleKey,
    names: readonly SavedSymbolName[],
  ): Promise<readonly string[]>;
}

export const RuntimeSymbolDrawer = defineHostService<RuntimeSymbolDrawerImpl>(
  "icons.runtime-symbol-drawer",
);

/**
 * The build of a runtime symbol from a set: the nearest-style fallback
 * (`resolveSymbol`), `buildSymbol` and the `runtimeSymbolId` scheme. Bump it
 * with any change to what those produce — it is folded into
 * {@link symbolsHash}, as `ACTIVE_FORM_VERSION` / `LUCIDE_TUNING_VERSION` are
 * into the sprites' manifest hash.
 */
export const RUNTIME_SYMBOL_BUILD_VERSION =
  "1: nearest-style fallback, msr-<key>-<name>";

/** One runtime symbol drawn from `sets` — the one build every drawer runs. */
export function drawRuntimeSymbol(
  sets: SymbolSets,
  key: StyleKey,
  name: SavedSymbolName,
): string {
  return buildSymbol({
    id: runtimeSymbolId(key, name),
    ...resolveSymbol(sets, name, key),
  });
}

// Per drawer, so a process that swaps the host's drawer (a test booting
// another graph) never reads one drawer's hash under another.
const hashes = new WeakMap<RuntimeSymbolDrawerImpl, string>();

/**
 * What a runtime symbol's answer is a function of — this host's drawer, the
 * saved-name list (which decides the `unknown-name` refusal) and the build
 * ({@link RUNTIME_SYMBOL_BUILD_VERSION}) — so a runtime-symbols tuple
 * carrying it is `immutable`. Fixed for a drawer; computed on first use.
 */
export function symbolsHash(): string {
  const drawer = RuntimeSymbolDrawer.get();
  let hash = hashes.get(drawer);
  if (hash === undefined) {
    hash = sha256Hex(
      [
        drawer.identity,
        allSavedSymbolNames().join(" "),
        RUNTIME_SYMBOL_BUILD_VERSION,
      ].join("\n"),
    ).slice(0, 16);
    hashes.set(drawer, hash);
  }
  return hash;
}

/** One hidden `<svg>` of `names`' runtime symbols in style `key`, drawn by this host's drawer. */
export async function runtimeSymbols(
  key: StyleKey,
  names: readonly SavedSymbolName[],
): Promise<string> {
  if (names.length === 0) return wrapSprite([]);
  return wrapSprite(await RuntimeSymbolDrawer.get().draw(key, names));
}
