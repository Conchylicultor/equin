import type { MouseEvent } from "react";
import type { Activation, LinkTarget } from "../../core";

/**
 * Handler props that give any control the browser's own link gestures:
 *
 *   • plain click                 → open it HERE
 *   • ⌘/Ctrl-click, middle-click  → open it ELSEWHERE, staying put
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
  };
}

/**
 * Open a URL in a new browser tab — the one place that is spelled. Takes an
 * app path of THIS origin (`/agents/c/42`) or an absolute URL (another
 * worktree's origin, an external site). Always `noopener`, so the new tab
 * cannot reach back into this one through `window.opener`; `noreferrer` too
 * when it leaves this origin, so an external site is not told where it was
 * opened from.
 */
export function openInBrowserTab(url: string): void {
  const target = new URL(url, window.location.origin);
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
      open({ elsewhere: e.metaKey || e.ctrlKey });
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
