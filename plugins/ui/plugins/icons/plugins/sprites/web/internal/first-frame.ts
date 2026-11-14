import { useEffect, useLayoutEffect, useRef } from "react";
import { z } from "zod";
import { recordBootSpan } from "@plugins/primitives/plugins/perfs/plugins/boot-trace/web";
import { defineStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { ownerPrefix } from "@plugins/primitives/plugins/dom/plugins/web-storage/core";
import { isStyleKey } from "@plugins/ui/plugins/icons/core";
import { pageRuntimeSymbols } from "@plugins/ui/plugins/icons/web";
import {
  FIRST_FRAME_MEMORY_MAX_GLYPHS,
  FIRST_FRAME_MEMORY_OWNER,
  type GlyphBatchAddress,
} from "../../shared/head-request";
import { headFirstFramePage, headProvidedGlyphs } from "./boot";
import type { RuntimeSymbolLoader } from "./runtime-symbol-loader";

/**
 * How long the first frame may wait for its glyphs before it paints anyway: a
 * bound around the network (a first visit's one batch is a few KB), never a
 * fix for a slow path of ours. Past it the page shows, its icons arriving as
 * their batch lands, and the wait is recorded on the boot trace.
 */
export const FIRST_FRAME_DEADLINE_MS = 3000;

/**
 * The page's memory of what its first frame drew: per page (the head's
 * `FIRST_FRAME_PAGE_JS`), the glyph batches — head-provided and newly
 * asked — in order, oldest first. Read by the shell's head script (it inlines
 * the store's key and reads the envelope's `v`), written here.
 */
const firstFrameMemory = defineStore({
  // A literal (the budget check reads it); asserted below to be the head's.
  owner: "ui.icons.first-frame",
  pageWide: {
    reason:
      "the page's own first frame: its glyphs are asked of the page's server, whatever app the page shows",
  },
  label: "Icon first frames",
  area: "local",
  cap: "64 KB",
  ttl: 30 * 24 * 60 * 60 * 1000,
  whenFull: "evict-oldest",
  schema: z.array(
    z.object({ hash: z.string(), key: z.string(), names: z.string() }),
  ),
});

// The head script reads the entry under the key it derives from the shared
// owner: a store under another key would be written and never read.
if (firstFrameMemory.key("") !== ownerPrefix(FIRST_FRAME_MEMORY_OWNER)) {
  throw new Error(
    `icon sprites: the first-frame store's key ${firstFrameMemory.key("")} is not the head's (${ownerPrefix(FIRST_FRAME_MEMORY_OWNER)})`,
  );
}

/** One-shot per page: only the page's first frame is held. */
let gated = false;

/**
 * Holds the page's FIRST paint until every glyph its first frame wants is in
 * the page's store — so no icon pops in after the first paint. Mounted by the
 * sprite host, which renders with the app's first commit (never the boot
 * screen's).
 *
 * - In the layout effect of that commit the document is hidden
 *   (`html { opacity: 0 }`, an adopted sheet: laid out, focusable, not painted).
 * - Every `<Icon>` asks for its glyphs in a layout effect too, so by this
 *   host's passive effect every want of the first commit is recorded.
 * - The document shows once the page's store has nothing pending (a failed
 *   batch is not pending), when the page's hashes cannot be read, or past
 *   {@link FIRST_FRAME_DEADLINE_MS}. Icons that mount after the first commit
 *   (a pane whose data loads later) are not waited for. A warm load's first frame wants nothing
 *   (the head provided last time's batches): it shows at once.
 * - Once settled, the batches the first frame used are remembered for the
 *   head script of the next load.
 */
export function useFirstFrameGate(
  loader: RuntimeSymbolLoader,
  hashes: { readonly current: GlyphHashes | null },
  /** The page's glyph hashes could not be read: nothing it asks can land. */
  hashesFailed: boolean,
): void {
  const held = useRef<{
    release: () => void;
    abandon: () => void;
  } | null>(null);
  useLayoutEffect(() => {
    if (gated) return;
    gated = true;
    const startMs = performance.now();
    // Laid out, not painted. A rule of its own (not an inline style on
    // <html>). `opacity`, not `visibility`: nothing inherits it (taking it
    // away restyles nothing else) and the page stays focusable — a field
    // focusing itself in the first commit keeps its focus.
    const hide = new CSSStyleSheet();
    hide.replaceSync("html { opacity: 0; }");
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, hide];
    let open = false;
    let released = false;
    let off = (): void => undefined;
    const finish = (why: "settled" | "deadline" | "no-hashes") => {
      if (open) return;
      open = true;
      off();
      clearTimeout(deadline);
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
        (s) => s !== hide,
      );
      recordBootSpan({
        id: "icon-first-frame",
        phase: "paint",
        label: "First frame's icon glyphs",
        startMs,
        durationMs: performance.now() - startMs,
        detail:
          why === "settled"
            ? `${loader.made().length} batch(es) asked`
            : why === "deadline"
              ? `deadline: ${pageRuntimeSymbols.pendingCount()} glyph(s) still loading`
              : "the page's glyph hashes could not be read",
      });
      if (why === "settled") remember(loader, hashes.current);
    };
    const deadline = setTimeout(
      () => finish("deadline"),
      FIRST_FRAME_DEADLINE_MS,
    );
    held.current = {
      abandon: () => finish("no-hashes"),
      release() {
        if (released) return;
        released = true;
        const check = () => {
          if (pageRuntimeSymbols.pendingCount() === 0) finish("settled");
        };
        off = pageRuntimeSymbols.subscribe(check);
        check();
      },
    };
  }, [loader, hashes]);
  // After every layout effect of the first commit: each `<Icon>`'s want is in.
  useEffect(() => {
    held.current?.release();
  }, []);
  useEffect(() => {
    if (hashesFailed) held.current?.abandon();
  }, [hashesFailed]);
}

/** The hash each glyph key's tuples carry, read from the page's server. */
export interface GlyphHashes {
  /** `icons.symbols-hash`: every Material style's. */
  readonly material: string;
  /** `icons.sprite-hash`: the Lucide keys'. */
  readonly sprite: string;
}

/**
 * Remember the first frame's batches for the next load's head: the ones the
 * head provided (they were drawn, or about to be) and the ones this frame had
 * to ask for (under `hashes`, the page's — `null` when they never landed, so
 * nothing was asked) — a changed first frame adds ONE batch and re-downloads
 * nothing. Past {@link FIRST_FRAME_MEMORY_MAX_GLYPHS} the oldest batches go.
 */
function remember(
  loader: RuntimeSymbolLoader,
  hashes: GlyphHashes | null,
): void {
  const asked: GlyphBatchAddress[] =
    hashes === null
      ? []
      : loader.made().map((b) => ({
          hash: isStyleKey(b.key) ? hashes.material : hashes.sprite,
          key: b.key,
          names: b.names.join(","),
        }));
  const kept: GlyphBatchAddress[] = [];
  let glyphs = 0;
  for (const b of [...headProvidedGlyphs(), ...asked].reverse()) {
    const n = b.names.split(",").length;
    if (glyphs + n > FIRST_FRAME_MEMORY_MAX_GLYPHS) break;
    glyphs += n;
    kept.unshift(b);
  }
  const page = headFirstFramePage();
  // No head (a shell served without it): nothing would read the memory.
  if (page === null) return;
  firstFrameMemory.write(page, kept);
}
