import { Apps, matchAppForPath } from "@plugins/apps-core/web";
import { splitRoutePrefix } from "@plugins/primitives/plugins/pane/plugins/route-prefix/web";
import {
  getTabId,
  useTabPresence,
  type TabPresence,
} from "@plugins/primitives/plugins/scope/plugins/tab-id/web";

/** What a page stamps on what it raises: its tab id and its page URL. */
export interface TabStamp {
  clientId: string | null;
  /** Absolute URL or root-relative path of the raising page; null when unknown. */
  url: string | null;
}

/**
 * Where something came from, relative to the reading page: nowhere known
 * (`none` — the server raised it), this very tab, or another tab — named by
 * the app its page belonged to (null when the URL is unknown or no app owns
 * it) and whether that tab is still open.
 */
export type TabOrigin =
  | { kind: "none" }
  | { kind: "this" }
  | { kind: "other"; appName: string | null; presence: TabPresence };

export function useTabOrigin(stamp: TabStamp): TabOrigin {
  const apps = Apps.App.useContributions();
  const own = stamp.clientId !== null && stamp.clientId === getTabId();
  const presence = useTabPresence(
    stamp.clientId === null || own ? null : stamp.clientId,
  );
  if (stamp.clientId === null) return { kind: "none" };
  if (own) return { kind: "this" };
  const appName =
    stamp.url === null
      ? null
      : (matchAppForPath(pathOf(stamp.url), apps)?.app.name ?? null);
  return { kind: "other", appName, presence };
}

// The app is decided by the path alone, past any surface-mode prefix (the
// desktop's /desktop) — the same read the router makes.
function pathOf(url: string): string {
  return splitRoutePrefix(new URL(url, "http://x").pathname).path;
}

/**
 * The origin in words: "this tab", "another Places tab", "closed Places tab"
 * (or without the app when unknown); null for `none`. Open and not yet known
 * read alike — "another" claims nothing about whether it is still open.
 */
export function tabOriginLabel(origin: TabOrigin): string | null {
  if (origin.kind === "none") return null;
  if (origin.kind === "this") return "this tab";
  const tab = origin.appName === null ? "tab" : `${origin.appName} tab`;
  return origin.presence === "closed" ? `closed ${tab}` : `another ${tab}`;
}
