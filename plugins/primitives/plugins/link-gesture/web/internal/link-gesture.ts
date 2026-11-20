import { renderMode } from "@plugins/primitives/plugins/dom/plugins/render-mode/core";
import { withActiveRoutePrefix } from "@plugins/primitives/plugins/pane/plugins/route-prefix/web";
import { defineInstallSink } from "@plugins/primitives/plugins/scope/plugins/install-sink/web";
import type { MouseEvent } from "react";
import type { Activation, Gesture, LinkTarget } from "../../core";

/**
 * Handler props that give any control the browser's own link gestures:
 *
 *   • plain click                 → open it HERE
 *   • ⌘/Ctrl-click, middle-click  → open it ELSEWHERE, staying put
 *   • ⌥/Alt-click                 → open it HERE, KEEPING the others
 *                                   (the {@link Gesture} — see {@link gestureOf})
 *
 * Build them with {@link linkProps} — "elsewhere" is a new browser tab at the
 * destination's URL, exactly what the same gesture does on an `<a href>`:
 *
 * ```tsx
 * <IconButton icon={navIcons.expand} label="Expand pane" {...linkProps({ open: go, href: () => url })} />
 * ```
 *
 * **Why this is not free.** The browser grants these gestures to `<a href>`
 * only — an anchor pointing at a document. A `<button>` gets none of them, so
 * a control that navigates has to read them itself. Doing that once, here, is
 * what keeps every such control agreeing on what a ⌘-click means.
 *
 * `Ctrl` is honoured for Windows/Linux, where it is THE new-tab modifier. On
 * macOS it is inert by construction: Ctrl-click is the secondary click there,
 * so the OS raises a context menu and no `click` event is ever delivered.
 *
 * Shift is deliberately untouched. In a browser it means "new window", and
 * whether this app draws windows at all is the surface mode — a per-surface
 * user setting that a single link has no business overriding.
 *
 * **Spread onto a real `<a href>`** (a link screen readers and keyboards can
 * follow), the props read that from the event: a plain click or Enter runs the
 * in-app open and cancels the document navigation, while ⌘/Ctrl-, Shift- and
 * middle-click are left to the browser, which opens the anchor's own href.
 */
export interface LinkGestureProps {
  onClick(e: MouseEvent): void;
  onAuxClick(e: MouseEvent): void;
  onMouseDown(e: MouseEvent): void;
  /**
   * The destination's app path, written into the markup ONLY in a static
   * render (`dom/render-mode`): that HTML is never hydrated, so no click ever
   * runs `href()`, and a robot reading it learns where the control leads from
   * this attribute (the snapshot turns `[data-link]` into `<a href>`). Absent
   * on a live page, where `href()` stays a click-time thunk.
   */
  "data-link"?: string;
}

/**
 * The {@link LinkGestureProps} of an in-app link: plain click runs `open`,
 * ⌘/Ctrl- and middle-click open `href()` in a new browser tab.
 *
 * `href` is a thunk, evaluated synchronously inside the click handler and only
 * for an "elsewhere" gesture. Synchronous, so `window.open` still runs inside
 * the user gesture and is not popup-blocked; at click time, so a destination
 * relative to what is on screen (a pane pushed beside the caller) is computed
 * against the screen the user clicked on, not the one this control rendered in.
 * It returns an app path (`/agents/c/42`), resolved against this origin.
 *
 * The one exception: in a static render (`dom/render-mode`) — HTML that is
 * never hydrated, so never clicked — `href()` runs during render and lands in
 * `data-link`, since the markup is all a robot reads.
 */
export function linkProps({ open, href }: LinkTarget): LinkGestureProps {
  const handlers = linkGestureProps(({ elsewhere, gesture }) => {
    if (elsewhere) openInBrowserTab(href());
    else open(gesture);
  });
  // A static render is never clicked: the destination goes in the markup, the
  // one place a robot can read it — as the address it is served at (a
  // composition serving its home app at `/` drops the base path,
  // `route-prefix`'s address root). A throwing href() fails that render loudly.
  if (renderMode() === "static")
    return { ...handlers, "data-link": withActiveRoutePrefix(href()) };
  return handlers;
}

/**
 * The {@link Gesture} of an input event: ⌥/Alt keeps the others. Takes any
 * event carrying the modifier (a click, an Enter keydown), so a keyboard
 * activation can read it the same way.
 */
export function gestureOf(e: Pick<MouseEvent, "altKey">): Gesture {
  return { keepOthers: e.altKey };
}

/**
 * The click props of an {@link Activation}: a {@link LinkTarget} gets the full
 * {@link linkProps} gestures, a plain action only `onClick`, and `undefined`
 * nothing at all — so a component that infers "is this a button" from
 * `onClick` (`Row`) still sees a non-activating element as a plain container.
 * Spread it; never wrap the activation in a closure first.
 *
 * `isolate` makes `onClick` and `onAuxClick` stop propagation before acting —
 * the one answer for a control nested inside another clickable thing (a chip
 * in a clickable row, a chip inside the page editor), whose activation must
 * not also activate its container. `onMouseDown` is left to propagate: drag
 * and text selection in the container start there and still need it.
 */
export function activationProps(
  activation: Activation | undefined,
  opts?: { isolate?: boolean },
): Partial<LinkGestureProps> {
  if (activation === undefined) return {};
  const isolate = opts?.isolate === true;
  if (typeof activation === "function") {
    if (!isolate) return { onClick: activation };
    return {
      onClick(e) {
        e.stopPropagation();
        activation();
      },
    };
  }
  const props = linkProps(activation);
  if (!isolate) return props;
  return {
    onClick(e) {
      e.stopPropagation();
      props.onClick(e);
    },
    onAuxClick(e) {
      e.stopPropagation();
      props.onAuxClick(e);
    },
    onMouseDown: props.onMouseDown,
    ...(props["data-link"] === undefined
      ? {}
      : { "data-link": props["data-link"] }),
  };
}

/**
 * How an in-app path (`/agents/c/42`) is written as the URL of a new browser
 * tab — decided by the tab set the user is in, which `apps-core/tabs` installs
 * here (this leaf cannot import it): the page's own writes it under its surface
 * mode's route prefix (`/desktop/agents/c/42`); an app embed may address its
 * own location on the page that hosts it (`/demo` opens its demo, full screen,
 * at that place). Until anything is installed, the page's route prefix.
 */
export const browserTabAddressSink = defineInstallSink<
  (path: string) => string
>({
  name: "link-gesture.browser-tab-address",
  what: "how an in-app path is written as a new browser tab's URL (installed by apps-core/tabs: the tab set the user is in decides)",
  fallback: withActiveRoutePrefix,
});

/**
 * The absolute URL a new browser tab opens for `url` — and so the URL that
 * shows `url` to anyone it is sent to (a copied share link). An in-app path
 * (`/agents/c/42`) is written the way the tab set the user is in shows it
 * ({@link browserTabAddressSink}: the page's under its surface mode's route
 * prefix, the desktop's `/desktop`; an app embed's on the page that hosts it,
 * the live demo's `/about/demo/at/…`), so it comes up the same; an absolute
 * URL is itself.
 */
export function browserTabUrl(url: string): string {
  const inApp = url.startsWith("/") && !url.startsWith("//");
  const address = inApp ? browserTabAddressSink.peek()(url) : url;
  return new URL(address, window.location.origin).href;
}

/**
 * Open a URL in a new browser tab — the one place that is spelled. Takes an
 * app path of THIS origin (`/agents/c/42`, addressed by
 * {@link browserTabAddressSink} — by default under the active route prefix,
 * `pane/plugins/route-prefix`) or an absolute URL (another
 * worktree's origin, an external site). Always `noopener`, so the new tab
 * cannot reach back into this one through `window.opener`; `noreferrer` too
 * when it leaves this origin, so an external site is not told where it was
 * opened from.
 */
export function openInBrowserTab(url: string): void {
  const target = new URL(browserTabUrl(url));
  const features =
    target.origin === window.location.origin
      ? "noopener"
      : "noopener,noreferrer";
  window.open(target, "_blank", features);
}

/**
 * The low-level form: `open` is told which gesture the user made and decides
 * itself what "elsewhere" means. Prefer {@link linkProps}; this is for the
 * control whose "elsewhere" is NOT a browser tab at an app path (open-app's
 * button flips a configured default between a browser tab on another origin
 * and a framed pane).
 */
export function linkGestureProps(
  open: (opts: { elsewhere: boolean; gesture: Gesture }) => void,
): LinkGestureProps {
  return {
    onClick(e) {
      if (isRealLink(e)) {
        // The browser already gives an `<a href>` its "elsewhere" gestures
        // (⌘/Ctrl → new tab, Shift → new window) at the anchor's own href:
        // leave them to it rather than opening a second tab ourselves.
        if (e.metaKey || e.ctrlKey || e.shiftKey) return;
        // A plain click (or Enter, which the browser delivers as one) opens
        // here, in place — never the document navigation the anchor would
        // otherwise run, which reloads the app and loses its tab state.
        e.preventDefault();
        open({ elsewhere: false, gesture: gestureOf(e) });
        return;
      }
      open({ elsewhere: e.metaKey || e.ctrlKey, gesture: gestureOf(e) });
    },
    onAuxClick(e) {
      if (e.button !== 1) return;
      // A real link's middle click is the browser's own new tab.
      if (isRealLink(e)) return;
      // The default middle-button action (autoscroll on Windows, paste on
      // X11) has nothing to do with navigating, so it never reaches the page.
      e.preventDefault();
      open({ elsewhere: true, gesture: gestureOf(e) });
    },
    onMouseDown(e) {
      // Autoscroll arms on mousedown, not on the aux click — cancelling it
      // there is too late to stop the scroll cursor appearing.
      if (e.button === 1 && !isRealLink(e)) e.preventDefault();
    },
  };
}

/**
 * Whether the handlers sit on a real `<a href>` — a control the browser
 * already navigates on click. Read off the event (the element the handler is
 * attached to), so the same props are right on a `<button>`, a `<div>` and an
 * anchor alike, with nothing for the call site to declare.
 */
function isRealLink(e: MouseEvent): boolean {
  const el = e.currentTarget;
  return (
    // `localName`, so an SVG `<a>` (whose `href` is not an HTMLAnchorElement's)
    // counts too.
    el instanceof Element && el.localName === "a" && el.hasAttribute("href")
  );
}
