/**
 * Document Picture-in-Picture: an always-on-top window the player moves into
 * whole — controls, panels and all — instead of the browser's own video
 * picture in picture, which shows the bare video under controls nobody can
 * theme.
 */

/** The `window.documentPictureInPicture` API (Chromium 116+), not in the DOM lib yet. */
export interface DocumentPictureInPicture {
  requestWindow(options: { width: number; height: number }): Promise<Window>;
}

export function documentPipOf(win: Window): DocumentPictureInPicture | null {
  const api = (win as Window & { documentPictureInPicture?: unknown })
    .documentPictureInPicture;
  return typeof api === "object" && api !== null
    ? (api as DocumentPictureInPicture)
    : null;
}

/** Whether any picture in picture is offered here: our own window, or the browser's video one. */
export function pipOffered(win: Window): boolean {
  return documentPipOf(win) !== null || win.document.pictureInPictureEnabled;
}

/**
 * Ask for our own window. The browser may refuse — inside a frame Chrome
 * answers "only allowed from a top-level browsing context", without a user
 * gesture it refuses too — and it says so with a `DOMException`: that, and
 * only that, answers `null` (the caller falls back to the video's own picture
 * in picture), with a warning naming why. Anything else is a bug and throws.
 */
export async function requestPipWindow(
  pip: DocumentPictureInPicture,
  size: { width: number; height: number },
): Promise<Window | null> {
  try {
    return await pip.requestWindow(size);
  } catch (err) {
    if (err instanceof DOMException) {
      console.warn(
        "Document picture-in-picture refused; using the browser's video picture in picture:",
        err,
      );
      return null;
    }
    throw err;
  }
}

/**
 * A stylesheet for the window: a `<link>` whose rules the page can read
 * (same origin) is inlined as a `<style>` of those rules — a cloned link in
 * the window's document is fetched again and, in Chromium, does not load
 * there — and anything else (a `<style>`, a cross-origin font sheet) is
 * cloned as is.
 */
function stylesheetCopy(n: Element, to: Document): Element {
  const sheet = n instanceof HTMLLinkElement ? n.sheet : null;
  const rules = sheet === null ? null : readableRules(sheet);
  if (rules === null) return n.cloneNode(true) as Element;
  const style = to.createElement("style");
  style.textContent = Array.from(rules, (r) => r.cssText).join("\n");
  return style;
}

/** A sheet's rules, or `null` for a cross-origin sheet the page may not read. */
function readableRules(sheet: CSSStyleSheet): CSSRuleList | null {
  try {
    return sheet.cssRules;
  } catch (err) {
    // The browser's answer for a cross-origin sheet: a SecurityError.
    if (err instanceof DOMException && err.name === "SecurityError")
      return null;
    throw err;
  }
}

/** Whether a body mutation is (in, or the arrival / removal of) an icon sheet. */
function touchesSprites(r: MutationRecord): boolean {
  if (r.target instanceof Element && r.target.closest(SPRITES)) return true;
  const isSheet = (n: Node) => n instanceof Element && n.matches(SPRITES);
  return (
    Array.from(r.addedNodes).some(isSheet) ||
    Array.from(r.removedNodes).some(isSheet)
  );
}

/** Marks what the mirror put into the window, so a re-sync replaces exactly that. */
const MIRROR = "data-pip-mirror";
/** The page's inline icon sheets: `<Icon>` draws `<use href="#…">` into them. */
const SPRITES = "[data-icon-sprites], [data-icon-families]";

/**
 * Dress a fresh picture-in-picture document as the page: its stylesheets, the
 * `<html>` attributes the theme paints through (the `dark` class, the inline
 * token variables) plus `data-pip`, and the inline icon sprites — without
 * them every `<use href="#…">` in the window draws nothing. Kept in sync while
 * the window is open (a theme switch adds a style, a new icon style mounts a
 * sprite): a mutation observer, not a poll. Returns the disposer.
 */
export function mirrorPageInto(from: Document, to: Document): () => void {
  const copyHead = () => {
    for (const n of to.head.querySelectorAll(`[${MIRROR}]`)) n.remove();
    for (const n of from.head.querySelectorAll(
      'style, link[rel="stylesheet"]',
    )) {
      const clone = stylesheetCopy(n, to);
      clone.setAttribute(MIRROR, "");
      to.head.append(clone);
    }
  };
  const copyAttributes = () => {
    const source = from.documentElement;
    const target = to.documentElement;
    // An attribute the page dropped (the `dark` class's owner switching
    // scheme removes `class`) leaves the window too.
    for (const a of Array.from(target.attributes)) {
      if (a.name !== "data-pip" && !source.hasAttribute(a.name))
        target.removeAttribute(a.name);
    }
    for (const a of Array.from(source.attributes)) {
      target.setAttribute(a.name, a.value);
    }
    target.setAttribute("data-pip", "");
  };
  const copySprites = () => {
    for (const n of to.body.querySelectorAll(`:scope > [${MIRROR}]`))
      n.remove();
    for (const n of from.querySelectorAll(SPRITES)) {
      const clone = n.cloneNode(true) as Element;
      clone.setAttribute(MIRROR, "");
      to.body.prepend(clone);
    }
  };
  copyHead();
  copyAttributes();
  copySprites();
  to.title = from.title;

  const view = from.defaultView;
  if (view === null) return () => undefined;
  const observer = new view.MutationObserver((records) => {
    let head = false;
    let attrs = false;
    let sprites = false;
    for (const r of records) {
      if (r.target === from.documentElement && r.type === "attributes")
        attrs = true;
      else if (from.head.contains(r.target)) head = true;
      else if (touchesSprites(r)) sprites = true;
    }
    if (head) copyHead();
    if (attrs) copyAttributes();
    if (sprites) copySprites();
  });
  observer.observe(from.documentElement, { attributes: true });
  observer.observe(from.head, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  // The whole body, not the sheets present now: a sheet can mount later (a
  // first icon of another style), and each record is filtered to the sheets.
  observer.observe(from.body, { childList: true, subtree: true });
  return () => observer.disconnect();
}
