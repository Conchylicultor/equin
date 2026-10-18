import { COPY_SOURCE_ATTR } from "./attr";

/**
 * Swap every declaring element in a cloned selection for the text it declared.
 *
 * Pure DOM on a detached fragment — it neither reads the live selection nor
 * writes the clipboard, which is what makes the substitution rule testable
 * without a layout engine. Returns how many elements it replaced, so the caller
 * can leave the native copy alone when the answer is zero.
 *
 * ## Nesting resolves outward, and the ordering is the whole rule
 *
 * An active-data chip declares its source token; the `Badge` it renders through
 * declares "my own text". Both are marked, one inside the other, and the token
 * has to win. `querySelectorAll` returns document order — ancestors before
 * descendants — so the outer element is replaced first and takes its whole
 * subtree with it. The inner one is then no longer in the fragment, which is
 * exactly the condition tested here. There is no precedence list to keep in
 * sync: the outer declaration wins because it is the one still standing.
 */
export function applyCopySources(fragment: DocumentFragment): number {
  let replaced = 0;
  const marked = Array.from(fragment.querySelectorAll(`[${COPY_SOURCE_ATTR}]`));
  for (const element of marked) {
    // Already carried off by an ancestor's replacement — see the header.
    if (!fragment.contains(element)) continue;
    const declared = element.getAttribute(COPY_SOURCE_ATTR) ?? "";
    const text = declared === "" ? (element.textContent ?? "") : declared;
    element.replaceWith(document.createTextNode(text));
    replaced++;
  }
  return replaced;
}
