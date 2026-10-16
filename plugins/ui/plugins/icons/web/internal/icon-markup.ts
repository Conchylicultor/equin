import type { IconRef, SpriteKey } from "../../core";
import { spriteMarkup, useSprites } from "./sprite-store";
import {
  runtimeSymbolChunks,
  useRuntimeSymbolChunks,
} from "./runtime-symbol-store";
import { resolveIconDrawing } from "./icon-drawing";
import { askFor, useIconStyle } from "./icon";

/**
 * One icon as standalone SVG content: the `<symbol>`'s inner markup and its
 * `viewBox`, to nest in an `<svg>` of one's own (`fill` / `color` set there —
 * the paths paint in `currentColor`). For a surface that cannot `<use>` the
 * page's sprite sheet: an SVG drawn as an image (a canvas sprite) sees no
 * document.
 */
export type IconMarkup =
  { kind: "ready"; viewBox: string; body: string } | { kind: "pending" };

/** Reads an icon's markup in the caller's theme scope style. */
export type IconMarkupReader = (
  icon: IconRef,
  opts: { active: boolean },
) => IconMarkup;

/** `<symbol id>` → its markup, per parsed sprite / chunk markup string. */
const parsed = new Map<
  string,
  ReadonlyMap<string, IconMarkup & { kind: "ready" }>
>();

function indexSymbols(
  markup: string,
): ReadonlyMap<string, IconMarkup & { kind: "ready" }> {
  const hit = parsed.get(markup);
  if (hit !== undefined) return hit;
  const doc = new DOMParser().parseFromString(markup, "image/svg+xml");
  const index = new Map<string, IconMarkup & { kind: "ready" }>();
  for (const el of doc.querySelectorAll("symbol[id]")) {
    index.set(el.id, {
      kind: "ready",
      viewBox: el.getAttribute("viewBox") ?? "0 0 24 24",
      body: el.innerHTML,
    });
  }
  // One entry per sprite / chunk the page ever held: bounded by the sheet.
  parsed.set(markup, index);
  return index;
}

function symbolMarkup(
  id: string,
  source: { kind: "sprite"; key: SpriteKey } | { kind: "runtime" },
): IconMarkup | undefined {
  if (source.kind === "sprite") {
    const markup = spriteMarkup(source.key);
    return markup === undefined ? undefined : indexSymbols(markup).get(id);
  }
  for (const [, markup] of runtimeSymbolChunks()) {
    const hit = indexSymbols(markup).get(id);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * `useIconMarkup()` → a reader of icon markup in this scope's icon style: the
 * SAME drawing `<Icon>` would `<use>` (`resolveIconDrawing`), as markup —
 * `pending` while nothing that could draw it is held. The component re-renders
 * when a sprite or chunk lands, and every icon a read found missing is asked
 * for (as a mounted `<Icon>` would ask) — on a microtask, never inside the
 * render that read it, since asking notifies the sprite host.
 */
export function useIconMarkup(): IconMarkupReader {
  const style = useIconStyle();
  // Subscriptions only: the reader reads the stores themselves.
  useSprites();
  useRuntimeSymbolChunks();
  return (icon, { active }) => {
    const { drawing, wants } = resolveIconDrawing(icon, style, active);
    for (const w of wants) queueMicrotask(() => askFor(w));
    if (drawing === null) return { kind: "pending" };
    const markup = symbolMarkup(drawing.id, drawing.source);
    if (markup === undefined) {
      // The resolver said this sprite holds the symbol: a sprite without it
      // is a manifest out of step with the code naming the icon.
      throw new Error(
        `[icons] ${drawing.id} is not in the sprite that should hold it`,
      );
    }
    return markup;
  };
}
