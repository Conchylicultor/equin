import type { ReactNode } from "react";
import { useWebPageLink } from "@plugins/apps/plugins/browser/plugins/page-pane/web";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import { parseUrl } from "@plugins/packages/plugins/floor-compat/core";

/**
 * Whether `href` is a site on the web, which the browser engine shows: an
 * absolute http(s) URL on another origin. A link to this app's own origin is
 * not — it is equin itself (a pane, an `/api` file), which a remote Chromium
 * without this browser's session cannot show.
 */
export function isWebUrl(href: string | undefined): boolean {
  if (href === undefined || !/^https?:\/\//i.test(href)) return false;
  return parseUrl(href)?.origin !== window.location.origin;
}

/**
 * A web link in the transcript: a plain click opens the page in the web-page
 * side pane beside the conversation (the Browser's rendering); ⌘/Ctrl-, Shift-
 * and middle-click are left to the browser, which opens the site itself in a
 * new browser tab — it is a real `<a href>`, so copying it, hovering it and
 * keyboard-following it behave as on any link.
 */
export function WebLink({
  href,
  children,
  ...rest
}: { href: string; children?: ReactNode } & Record<string, unknown>) {
  const webPageLink = useWebPageLink();
  return (
    <a
      {...rest}
      className="text-primary-text underline"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      {...activationProps(webPageLink(href), { isolate: true })}
    >
      {children}
    </a>
  );
}
