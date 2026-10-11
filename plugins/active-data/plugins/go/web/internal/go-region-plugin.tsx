import { useCallback, useEffect, useRef, useState } from "react";
import { useResizeObserver } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createTextNode, $getNodeByKey, type LexicalEditor } from "lexical";
import { $scan, markerToken, type Region } from "./go-regions";
import { GO_INLINE_BOX } from "../components/go-cap";
import { RAIL_WIDTH, setRails, type RailBox } from "./go-rails";

// Painted onto the editor's own DOM — classes and the root's background, never
// nodes — so the draft's text, and therefore what is sent, is untouched. The
// same look the reply draws a Go in; the words keep their colour.
// An inline region wears the reply's inline Go box (`GO_INLINE_BOX`).
const INLINE_CLASSES = [
  ...GO_INLINE_BOX.split(" "),
  "border-l",
  "rounded-l-inline-code",
];
const BLOCK_TEXT_CLASSES: string[] = [];
/** The block box's opacity of `--primary` — `GO_TINT`'s /5. */
const BOX_OPACITY = 0.05;

/** A rounded tint as a background layer: `color` is the theme's primary. */
function boxLayer(color: string, w: number, h: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" rx="6" fill="${color}" fill-opacity="${BOX_OPACITY}"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/**
 * The boxes of the block regions, as background layers on the editor root —
 * the root scrolls its own content and Lexical owns its children, so a box
 * cannot be an element in it. `background-attachment: local` makes the layers
 * scroll with the text. Returns each box's rail (its right edge, where the
 * close marker draws the ✕), whose width the root's right padding reserves
 * while a box is present so no line runs under it.
 */
function paintBoxes(
  editor: LexicalEditor,
  regions: Region[],
): Map<string, RailBox> {
  const rails = new Map<string, RailBox>();
  const root = editor.getRootElement();
  if (!root) return rails;
  // Measured without our reservation, then reserved before the lines are
  // measured (it rewraps them).
  root.style.paddingRight = "";
  const style = getComputedStyle(root);
  const padL = parseFloat(style.paddingLeft);
  const padR = parseFloat(style.paddingRight);
  const hasBox = regions.some((r) => r.block);
  if (hasBox) {
    root.style.paddingRight = `${padR + RAIL_WIDTH}px`;
    // The rails are placed against the root, which scrolls them with the text.
    if (style.position === "static") root.style.position = "relative";
  }
  const color = style.getPropertyValue("--primary").trim() || "currentColor";
  const rootRect = root.getBoundingClientRect();
  const layers: string[] = [];
  const positions: string[] = [];
  for (const region of regions) {
    if (!region.block) continue;
    const a = editor.getElementByKey(region.open);
    const b = editor.getElementByKey(region.close);
    if (!a || !b) continue;
    const range = document.createRange();
    range.setStartBefore(a);
    range.setEndAfter(b);
    const rect = range.getBoundingClientRect();
    const x = Math.max(0, padL - 6);
    const y = rect.top - rootRect.top + root.scrollTop - 3;
    const w = root.clientWidth - x - Math.max(0, padR - 6);
    const h = rect.height + 6;
    layers.push(boxLayer(color, w, h));
    positions.push(`${x}px ${y}px`);
    rails.set(region.close, { left: x + w - RAIL_WIDTH, top: y, height: h });
  }
  root.style.backgroundImage = layers.join(", ");
  root.style.backgroundPosition = positions.join(", ");
  root.style.backgroundRepeat = "no-repeat";
  root.style.backgroundAttachment = "local";
  return rails;
}

/**
 * Paints each `<go>` region of a draft — the text between its two marker
 * tokens — in the suggestion highlight: a one-line region tinted in the line,
 * a multi-line one as a box. A marker whose partner was deleted turns back into
 * its literal text, so a region never leaves an invisible half behind.
 */
export function GoRegionPlugin() {
  const [editor] = useLexicalComposerContext();
  const regions = useRef<Region[]>([]);
  const marked = useRef<Array<[HTMLElement, string[]]>>([]);
  const [root, setRoot] = useState<HTMLElement | null>(null);

  const repaint = useCallback(() => {
    for (const [el, classes] of marked.current) el.classList.remove(...classes);
    marked.current = [];
    for (const region of regions.current) {
      const classes = region.block ? BLOCK_TEXT_CLASSES : INLINE_CLASSES;
      for (const key of region.inner) {
        const el = editor.getElementByKey(key);
        if (!el) continue;
        if (classes.length > 0) el.classList.add(...classes);
        marked.current.push([el, classes]);
      }
    }
    setRails(editor, paintBoxes(editor, regions.current));
  }, [editor]);

  useEffect(() => editor.registerRootListener(setRoot), [editor]);

  useEffect(
    () =>
      editor.registerUpdateListener(({ editorState }) => {
        const scan = editorState.read($scan);
        if (scan.orphans.length > 0) {
          editor.update(() => {
            for (const key of scan.orphans) {
              const node = $getNodeByKey(key);
              const token = node ? markerToken(node) : null;
              if (node && token !== null) node.replace($createTextNode(token));
            }
          });
          return;
        }
        regions.current = scan.regions;
        repaint();
      }),
    [editor, repaint],
  );

  // A width change rewraps the lines under a box.
  useResizeObserver(() => root, repaint, { deps: [root] });

  return null;
}
