import {
  familyGlyphMarkup,
  type IconFamily,
  type IconRef,
  type IconStyle,
  type InlineIconFamily,
  type SpriteKey,
} from "../../core";
import { useMemo } from "react";
import { heldSprites, useSprites } from "./sprite-store";
import {
  pageRuntimeSymbols,
  useRuntimeSymbolChunks,
  type RuntimeSymbolStore,
} from "./runtime-symbol-store";
import {
  resolveIconDrawing,
  type DrawingSource,
  type IconStores,
} from "./icon-drawing";
import { heldFamilies, useIconFamilies } from "./family-store";
import { askFor, useIconStores, useIconStyle } from "./icon";
import { reportIconFamilyGap } from "./family-gap";
import { MISSING_GLYPH_BODY, reportIconMissingGlyph } from "./missing-glyph";
import { useIconFamilyPreview } from "./icon-scope";

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

/** Each app-drawn family's sheet markup, built once per family object. */
const familyMarkup = new WeakMap<InlineIconFamily, string>();

function markupOfFamily(family: InlineIconFamily): string {
  let markup = familyMarkup.get(family);
  if (markup === undefined) {
    markup = familyGlyphMarkup(family);
    familyMarkup.set(family, markup);
  }
  return markup;
}

/**
 * What the icon stores held in the render a reader was made in: their
 * snapshots (`useSyncExternalStore` values). A reader looks markup up in
 * these, never in the stores themselves, so it is a function of them — and a
 * new one whenever a sprite, chunk or family lands. Its identity is what a
 * memoized consumer (`useMemo`, the React Compiler's caches) keys a read on:
 * a reader that read the live stores behind a stable identity let such a
 * cache hold a `pending` answer after its glyph landed, forever.
 */
interface HeldIcons {
  readonly sprites: readonly (readonly [SpriteKey, string])[];
  readonly chunks: ReadonlyMap<
    RuntimeSymbolStore,
    readonly (readonly [string, string])[]
  >;
  readonly families: readonly IconFamily[];
}

/** What the stores hold right now — to tell a stale reader from a resolver bug. */
function heldNow(stores: IconStores): HeldIcons {
  const all = new Set([pageRuntimeSymbols, stores.saved, stores.family]);
  return {
    sprites: heldSprites(),
    chunks: new Map([...all].map((s) => [s, s.chunks()])),
    families: heldFamilies(),
  };
}

function symbolMarkup(
  id: string,
  source: DrawingSource,
  held: HeldIcons,
): IconMarkup | undefined {
  if (source.kind === "family" || source.kind === "gap") {
    const family = held.families.find((f) => f.id === source.family);
    return family?.kind === "inline"
      ? indexSymbols(markupOfFamily(family)).get(id)
      : undefined;
  }
  if (source.kind === "sprite") {
    const markup = held.sprites.find(([key]) => key === source.key)?.[1];
    return markup === undefined ? undefined : indexSymbols(markup).get(id);
  }
  if (source.kind !== "runtime") return undefined;
  for (const [, markup] of held.chunks.get(source.store) ?? []) {
    const hit = indexSymbols(markup).get(id);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** The reader of `held`, in `style`: a pure function of its arguments, so memoized with them. */
function markupReader(
  style: IconStyle,
  previewing: boolean,
  stores: IconStores,
  held: HeldIcons,
): IconMarkupReader {
  return (icon, { active }) => {
    const { drawing, wants } = resolveIconDrawing(icon, style, active, stores);
    for (const w of wants) queueMicrotask(() => askFor(w));
    if (drawing === null) return { kind: "pending" };
    const { source } = drawing;
    if (source.kind === "gap" && !previewing) {
      queueMicrotask(() =>
        reportIconFamilyGap({ family: source.family, name: source.name }),
      );
    }
    if (source.kind === "missing") {
      queueMicrotask(() =>
        reportIconMissingGlyph({ sprite: source.sprite, id: source.id }),
      );
      return { kind: "ready", viewBox: "0 0 24 24", body: MISSING_GLYPH_BODY };
    }
    const markup = symbolMarkup(drawing.id, source, held);
    if (markup !== undefined) return markup;
    // Called after the render it was made in, once the stores moved on: the
    // render that move triggers hands its caller a new reader.
    if (symbolMarkup(drawing.id, source, heldNow(stores)) !== undefined) {
      return { kind: "pending" };
    }
    // The resolver checked the held sprite has it (a missing one is the
    // `missing` source above): reaching here is a resolver bug.
    throw new Error(
      `[icons] ${drawing.id} is not in the sprite that should hold it`,
    );
  };
}

/**
 * `useIconMarkup()` → a reader of icon markup in this scope's icon style: the
 * SAME drawing `<Icon>` would `<use>` (`resolveIconDrawing`), as markup —
 * `pending` while nothing that could draw it is held. The component re-renders
 * when a sprite, chunk or family lands, and is handed a NEW reader then (one
 * per held state, so a read memoized on the reader is re-read); every icon a
 * read found missing is asked for (as a mounted `<Icon>` would ask) — on a
 * microtask, never inside the render that read it, since asking notifies the
 * sprite host.
 */
export function useIconMarkup(): IconMarkupReader {
  const style = useIconStyle();
  // A preview shows gaps on purpose: only an app drawing one is reported.
  const previewing = useIconFamilyPreview() !== undefined;
  const stores = useIconStores();
  const sprites = useSprites();
  const pageChunks = useRuntimeSymbolChunks(pageRuntimeSymbols);
  const savedChunks = useRuntimeSymbolChunks(stores.saved);
  const familyChunks = useRuntimeSymbolChunks(stores.family);
  const families = useIconFamilies();
  return useMemo(
    () =>
      markupReader(style, previewing, stores, {
        sprites,
        chunks: new Map([
          [pageRuntimeSymbols, pageChunks],
          [stores.saved, savedChunks],
          [stores.family, familyChunks],
        ]),
        families,
      }),
    [
      style,
      previewing,
      stores,
      sprites,
      pageChunks,
      savedChunks,
      familyChunks,
      families,
    ],
  );
}
