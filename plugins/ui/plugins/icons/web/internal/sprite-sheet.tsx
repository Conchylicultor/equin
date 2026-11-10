import { useMemo } from "react";
import { useSprites } from "./sprite-store";
import {
  pageRuntimeSymbols,
  useRuntimeSymbolChunks,
  type RuntimeSymbolStore,
} from "./runtime-symbol-store";
import { SymbolSheet, type SheetEntry } from "./symbol-sheet";

/**
 * The page's sprites and saved-icon symbols, inline: one `<svg>` per loaded
 * sprite and per chunk of the page's runtime symbols (`SymbolSheet` — the
 * symbols out of every style recalc, their masks rendered).
 *
 * Mounted once, by the sprite host.
 */
export function IconSpriteSheet() {
  const sprites = useSprites();
  const runtime = useRuntimeSymbolChunks(pageRuntimeSymbols);
  const entries = useMemo(
    (): SheetEntry[] => [
      ...sprites.map(([key, markup]) => ({
        key,
        markup,
        attribute: "data-sprite" as const,
      })),
      ...runtimeEntries(runtime),
    ],
    [sprites, runtime],
  );
  return <SymbolSheet entries={entries} attribute="data-icon-sprites" />;
}

/**
 * A plugin scope's saved-icon symbols, inline like the page's sheet: rendered
 * inside the scope by whoever gives it its store (the sprites plugin's
 * `ScopeIconSymbols`). Its ids carry the store's prefix, so it never repeats
 * one of the page's sheet.
 */
export function RuntimeSymbolSheet({ store }: { store: RuntimeSymbolStore }) {
  const runtime = useRuntimeSymbolChunks(store);
  const entries = useMemo(() => runtimeEntries(runtime), [runtime]);
  return (
    <SymbolSheet entries={entries} attribute="data-runtime-symbol-sheet" />
  );
}

// The server's own `<svg>` of `<symbol>`s, built from the Iconify JSON for
// names it checked against the installed sets — never user markup.
function runtimeEntries(
  chunks: readonly (readonly [string, string])[],
): SheetEntry[] {
  return chunks.map(([key, markup]) => ({
    key,
    markup,
    attribute: "data-runtime-symbols",
  }));
}
