/** The controls a press or double-click in belongs to the text, not the chrome. */
const TEXT_ENTRY = "input, textarea, select";

/**
 * Whether a pointer gesture caught by a chrome surface — a drag handle, a
 * header's double-click — is the surface's own, so it may act on it.
 *
 * Two ways it is not, both of which turned text selection into moving a column:
 *
 * - **It came through a portal.** React bubbles a synthetic event up the
 *   COMPONENT tree, so a press in a popover opened from a header (portaled to
 *   the body) still reaches the header's handlers. Containment is checked on
 *   the DOM, where the popover is not inside the header.
 * - **It landed in text entry** (an input, a textarea, a select, an editable
 *   region): there a press-and-drag selects and a double-click picks a word.
 */
export function isChromeGesture(event: {
  target: EventTarget | null;
  currentTarget: EventTarget | null;
}): boolean {
  const { target, currentTarget } = event;
  if (!(target instanceof Node) || !(currentTarget instanceof Node))
    return false;
  if (!currentTarget.contains(target)) return false;
  const element = target instanceof Element ? target : target.parentElement;
  if (element == null) return false;
  return element.closest(TEXT_ENTRY) == null && !isEditable(element);
}

/** Inside an editable region: the nearest `contenteditable` says so, unless it
 *  is `"false"` (an editor's inline decorator — a chip, not text). Read from the
 *  attribute, which every DOM (jsdom included) has; `isContentEditable` is
 *  layout-engine-only. */
function isEditable(element: Element): boolean {
  const host = element.closest("[contenteditable]");
  return host != null && host.getAttribute("contenteditable") !== "false";
}
