import { withActiveRoutePrefix } from "@plugins/primitives/plugins/pane/plugins/route-prefix/web";
import { defineInstallSink } from "@plugins/primitives/plugins/scope/plugins/install-sink/web";
import type { MouseEvent } from "react";
import type { Activation, LinkTarget } from "../../core";

/**
 * Handler props that give any control the browser's own link gestures:
 *
 *   • plain click                 → open it HERE
 *   • ⌘/Ctrl-click, middle-click  → open it ELSEWHERE, staying put
 *   • ⌥/Alt-click                 → open it HERE, KEEPING the others
 *                                   (see {@link keepsOthers})
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
 */
export interface LinkGestureProps {
  onClick(e: MouseEvent): void;
  onAuxClick(e: MouseEvent): void;
  onMouseDown(e: MouseEvent): void;
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
 */
export function linkProps({ open, href }: LinkTarget): LinkGestureProps {
  return linkGestureProps(({ elsewhere }) => {
    if (elsewhere) openInBrowserTab(href());
    else open();
  });
}

// ---------------------------------------------------------------------------
// The keep-others gesture (⌥/Alt-click)
//
// Plain click on something that opens or closes a pane REPLACES what stands to
// its right (an open truncates after the caller, a close drops every pane right
// of the closed one). ⌥-click is the same action with the others kept: an open
// inserts the new pane beside the caller, a close removes only that pane.
//
// It is ambient — scoped to the synchronous run of the click's handler — rather
// than a field of `LinkTarget`, because a link passes through many hands before
// it is clicked (a toggle wrapping a push, `afterOpen`, a row's activation):
// a field every wrapper had to forward would be dropped by the first one that
// did not know about it, silently. Ambient, the gesture reaches the one place
// that acts on it (the pane store's open and close) through any wrapping.
// ---------------------------------------------------------------------------

let keepOthersActive = false;

/**
 * Whether the click being handled right now asked to keep the others (⌥/Alt).
 * Read by whatever ACTS on a navigation (the pane store), synchronously inside
 * the click — outside a click handler run through this module it is `false`.
 */
export function keepsOthers(): boolean {
  return keepOthersActive;
}

/**
 * Run `fn` as the response to the click `e`: inside it, {@link keepsOthers}
 * answers whether `e` was an ⌥/Alt-click. Every handler this module builds runs
 * through it; a control whose click is not one of them (a pane's × close) wraps
 * its own handler with {@link clickProps}.
 */
function runClick(e: Pick<MouseEvent, "altKey">, fn: () => void): void {
  const prev = keepOthersActive;
  keepOthersActive = e.altKey;
  try {
    fn();
  } finally {
    keepOthersActive = prev;
  }
}

/**
 * The `onClick` of a plain action that navigates without being a link (a
 * pane's × close): it runs `action` with the click's ⌥ gesture readable
 * through {@link keepsOthers}.
 */
export function clickProps(action: () => void): {
  onClick(e: MouseEvent): void;
} {
  return {
    onClick(e) {
      runClick(e, action);
    },
  };
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
    const props = clickProps(activation);
    if (!isolate) return props;
    return {
      onClick(e) {
        e.stopPropagation();
        props.onClick(e);
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
  // An in-app path opens the way the tab set the user is in shows it (the
  // page's: under its surface mode's route prefix, the desktop's `/desktop`),
  // so the new tab comes up the same.
  const inApp = url.startsWith("/") && !url.startsWith("//");
  const address = inApp ? browserTabAddressSink.peek()(url) : url;
  const target = new URL(address, window.location.origin);
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
  open: (opts: { elsewhere: boolean }) => void,
): LinkGestureProps {
  return {
    onClick(e) {
      runClick(e, () => open({ elsewhere: e.metaKey || e.ctrlKey }));
    },
    onAuxClick(e) {
      if (e.button !== 1) return;
      // The default middle-button action (autoscroll on Windows, paste on
      // X11) has nothing to do with navigating, so it never reaches the page.
      e.preventDefault();
      open({ elsewhere: true });
    },
    onMouseDown(e) {
      // Autoscroll arms on mousedown, not on the aux click — cancelling it
      // there is too late to stop the scroll cursor appearing.
      if (e.button === 1) e.preventDefault();
    },
  };
}
