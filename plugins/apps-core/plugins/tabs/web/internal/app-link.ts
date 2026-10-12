import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import {
  linkProps,
  type LinkGestureProps,
} from "@plugins/primitives/plugins/link-gesture/web";
import { navigate } from "./use-tabs";

/**
 * Turn any control into an in-app link to `url`: plain click navigates here,
 * ⌘/Ctrl- and middle-click open `url` in a new browser tab. Spread it onto the
 * control.
 *
 * ```tsx
 * <IconButton icon={MdOpenInNew} label="Open the run" {...appLinkProps(url)} />
 * ```
 *
 * The browser-tab answer is the browser's own convention for those gestures,
 * which is what a user's hand already expects of anything that looks like a
 * link. The URL is app-rooted, so the new tab cold-boots straight into it. A new
 * IN-APP tab is a deliberate act instead — an explicit menu entry calling
 * `navigate(url, { newTab: true })` — never a modifier on a click.
 *
 * Still a button rather than an `<a href>`: the gestures come from
 * `link-gesture`, which is also what the pane primitive's Expand reads.
 */
export function appLinkProps(url: string): LinkGestureProps {
  return linkProps(appLink(url));
}

/**
 * The in-app link to `url` as DATA ({@link LinkTarget}): a plain click (or
 * Enter) navigates the focused tab there; an "elsewhere" gesture opens `url` in
 * a new browser tab. Hand it to anything that takes an `Activation`
 * (`activationProps`, a row's / chip's `activation` prop).
 */
export function appLink(url: string): LinkTarget {
  return { open: () => navigate(url), href: () => url };
}
