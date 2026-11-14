import { useEffect, useState } from "react";
import type { IconRef } from "@plugins/ui/plugins/icons/core";
import { useIconMarkup } from "@plugins/ui/plugins/icons/web";

/** A glyph as the canvas draws it: the icon in white on transparent, 64 px square. */
export type GlyphImages = ReadonlyMap<string, HTMLCanvasElement>;

export type GlyphsState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly error: Error }
  | { readonly kind: "ready"; readonly glyphs: GlyphImages };

const SIZE = 64;

async function rasterize(
  viewBox: string,
  body: string,
): Promise<HTMLCanvasElement> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${SIZE}" height="${SIZE}" fill="#ffffff" color="#ffffff">${body}</svg>`;
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const img = new Image(SIZE, SIZE);
    img.src = url;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = SIZE;
    c.height = SIZE;
    const g = c.getContext("2d");
    if (!g) throw new Error("isle glyphs: no 2D context");
    g.drawImage(img, 0, 0, SIZE, SIZE);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Every app's icon rasterised for the canvas (its signpost and its building's
 * hanging sign): read from the page's icon sprites in this scope's style
 * (`useIconMarkup`), decoded as an image once each. Loading until every glyph
 * is in — a building is never painted without its glyph.
 */
export function useGlyphImages(
  icons: readonly { id: string; icon: IconRef }[],
): GlyphsState {
  const read = useIconMarkup();
  const marks = icons.map((a) => ({
    id: a.id,
    m: read(a.icon, { active: true }),
  }));
  // the glyphs to rasterise, as one string: the effect re-runs only when one changes
  const spec = marks.every((x) => x.m.kind === "ready")
    ? JSON.stringify(
        marks.map((x) =>
          x.m.kind === "ready" ? [x.id, x.m.viewBox, x.m.body] : [x.id, "", ""],
        ),
      )
    : null;
  const [state, setState] = useState<{ spec: string; s: GlyphsState } | null>(
    null,
  );
  useEffect(() => {
    if (spec === null) return;
    let live = true;
    const list = JSON.parse(spec) as [string, string, string][];
    void Promise.all(
      list.map(
        async ([id, viewBox, body]) =>
          [id, await rasterize(viewBox, body)] as const,
      ),
    ).then(
      (done) => {
        if (live)
          setState({ spec, s: { kind: "ready", glyphs: new Map(done) } });
      },
      (err: unknown) => {
        if (live)
          setState({
            spec,
            s: {
              kind: "error",
              error: err instanceof Error ? err : new Error(String(err)),
            },
          });
      },
    );
    return () => {
      live = false;
    };
  }, [spec]);
  return state !== null && state.spec === spec ? state.s : { kind: "loading" };
}
