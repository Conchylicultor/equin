import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import {
  linkProps,
  type LinkGestureProps,
} from "@plugins/primitives/plugins/link-gesture/web";
import { useAppNavBoundary } from "@plugins/primitives/plugins/pane/web";
import { navigate, type NavigateOptions } from "./use-tabs";

/**
 * {@link navigate} as this subtree reaches it: through the nearest
 * `AppNavBoundary` (an in-process app embed decides where its own links go),
 * else the tab manager's. A component that can render inside an embed calls
 * this instead of the free function, so it never drives the host's tabs.
 */
export function useNavigate(): (url: string, opts?: NavigateOptions) => void {
  return useAppNavBoundary() ?? navigate;
}

/** {@link appLink} through {@link useNavigate}: an in-app link that respects an embed's boundary. */
export function useAppLink(): (url: string) => LinkTarget {
  const go = useNavigate();
  return (url) => ({ open: () => go(url), href: () => url });
}

/** {@link appLinkProps} through {@link useNavigate}. */
export function useAppLinkProps(): (url: string) => LinkGestureProps {
  const link = useAppLink();
  return (url) => linkProps(link(url));
}
