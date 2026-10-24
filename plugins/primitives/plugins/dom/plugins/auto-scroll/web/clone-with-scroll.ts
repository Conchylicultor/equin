/**
 * A deep copy of `source` that, once placed, shows what `source` showed — its
 * scroll offsets included. `cloneNode` copies the DOM but not where each
 * scroller stood (a transcript scrolled half-way would show its top), and an
 * offset can only be written on a connected element, so the copy comes with
 * `carryScroll`: call it right after inserting `clone`.
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
