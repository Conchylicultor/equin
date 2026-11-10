import type { Session } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";

/** Where the visit came from: the referring host, else its campaign source, else "Direct". */
export function sourceOf(s: Session): string {
  return s.referrerHost ?? s.utmSource ?? "Direct";
}

/** "macOS · Chrome · from github.com" — the row's second line. */
export function softwareLine(s: Session): string {
  return `${s.os} · ${s.browser} · from ${sourceOf(s)}`;
}
