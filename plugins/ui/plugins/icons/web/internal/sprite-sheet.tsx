import { useSprites } from "./sprite-store";
import { useRuntimeSymbolChunks } from "./runtime-symbol-store";
import { SHEET_STYLE } from "./sheet-style";

/**
 * The page's sprites, inline: a hidden container holding one `<svg>` per
 * loaded sprite, so every `<use href="#id">` resolves in-document — inside
 * portals and Fullscreen API subtrees too, which an external `file.svg#id`
 * reference would not reach without a second fetch per document.
 *
 * Zero-size, not `hidden`: a derived active form (the Lucide active sprite's)
 * holds masks, and a mask under a `display: none` ancestor is not rendered —
 * every `<use>` of it would draw nothing.
 *
 * Mounted once, by the sprite host.
 */
export function IconSpriteSheet() {
  const sprites = useSprites();
  const runtime = useRuntimeSymbolChunks();
  return (
    <div aria-hidden style={SHEET_STYLE} data-icon-sprites="">
      {sprites.map(([key, markup]) => (
        <div
          key={key}
          data-sprite={key}
          // The markup is the server's own `<svg>` of `<symbol>`s, built from the
          // Iconify JSON in node_modules — never user input.
          dangerouslySetInnerHTML={{ __html: markup }}
        />
      ))}
      {runtime.map(([chunkId, markup]) => (
        <div
          key={chunkId}
          data-runtime-symbols={chunkId}
          // The server's own `<svg>` of `<symbol>`s, built from the Iconify JSON
          // for names it checked against the installed sets — never user markup.
          dangerouslySetInnerHTML={{ __html: markup }}
        />
      ))}
    </div>
  );
}
