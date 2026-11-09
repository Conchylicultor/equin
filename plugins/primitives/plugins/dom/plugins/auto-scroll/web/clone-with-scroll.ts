/**
 * A deep copy of `source` that, once placed, shows what `source` showed — its
 * scroll offsets included. `cloneNode` copies the DOM but not where each
 * scroller stood (a transcript scrolled half-way would show its top), and an
 * offset can only be written on a connected element, so the copy comes with
 * `carryScroll`: call it right after inserting `clone`.
 *
 * Nothing in the copy loads anything: a copied frame or media element would
 * fetch its source again the moment it is placed (a whole video re-downloaded
 * to fade out, a revoked `blob:` URL failing in the console), so each one is
 * kept as an empty box of the same size and look ({@link inertCopy}).
 *
 * For a stand-in drawn in place of content React is about to remove (a column
 * fading out after its pane closed). A compensation, not a navigation — no
 * reader moved, so it announces nothing.
 */
export function cloneWithScroll<T extends Element>(
  source: T,
): { clone: T; carryScroll: () => void } {
  const clone = source.cloneNode(true) as T;
  const from = [source, ...source.querySelectorAll("*")];
  const to = [clone, ...clone.querySelectorAll("*")];
  const places: { el: Element; top: number; left: number }[] = [];
  from.forEach((el, i) => {
    const copy = to[i];
    if (!copy || (el.scrollTop === 0 && el.scrollLeft === 0)) return;
    places.push({ el: copy, top: el.scrollTop, left: el.scrollLeft });
  });
  for (const el of clone.querySelectorAll(LOADING_ELEMENTS)) inertCopy(el);
  return {
    clone,
    carryScroll: () => {
      for (const { el, top, left } of places) {
        el.scrollTop = top;
        el.scrollLeft = left;
      }
    },
  };
}

/** Elements that fetch a source of their own once connected. */
const LOADING_ELEMENTS = "iframe, frame, object, embed, video, audio";

/** The attributes that name what such an element loads. */
const SOURCE_ATTRIBUTES = ["src", "srcdoc", "data", "poster"] as const;

/**
 * Empties a copied loading element before it is connected: its source
 * attributes go, and so do its `<source>` / `<track>` children — the box
 * keeps its classes and inline style, so it holds the same place.
 */
function inertCopy(el: Element): void {
  for (const name of SOURCE_ATTRIBUTES) el.removeAttribute(name);
  for (const child of el.querySelectorAll("source, track")) child.remove();
}
