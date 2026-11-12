import type { Session } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";

/**
 * Where the visit came from: the referring page (`news.ycombinator.com/item`,
 * the bare host when the referrer sent only its root — as Facebook, Google and
 * most sites do), else its campaign source, else "Direct". The query string is
 * never stored, so this is all of the referrer there is.
 */
export function sourceOf(s: Session): string {
  if (s.referrerHost !== null) {
    return s.referrerPath === null || s.referrerPath === "/"
      ? s.referrerHost
      : `${s.referrerHost}${s.referrerPath}`;
  }
  return s.utmSource ?? "Direct";
}

/** "macOS · Chrome · from github.com" — the row's second line. */
export function softwareLine(s: Session): string {
  return `${s.os} · ${s.browser} · from ${sourceOf(s)}`;
}
