import {
  combineResources,
  mapResource,
  type ResourceResult,
  type ResourceUnavailable,
} from "@plugins/primitives/plugins/live-state/web";
import type { BackgroundEntry } from "../../core";

/**
 * One entry, looked up in both halves. Found as soon as the half holding it is
 * ready — the other may still be loading; otherwise the halves' combined state
 * (error > loading > ready), where ready means absent (`null`) — known only
 * once BOTH halves have answered. An `unavailable` half (no central runtime
 * behind this subtree's transport — the demo) answers too: it runs nothing
 * here, so it holds no entry.
 */
export function findEntry(
  halves: readonly (ResourceResult<BackgroundEntry[]> | ResourceUnavailable)[],
  kind: string,
  name: string,
): ResourceResult<BackgroundEntry | null> {
  const pick = (entries: BackgroundEntry[]): BackgroundEntry | null =>
    entries.find((e) => e.kind === kind && e.name === name) ?? null;
  const asked = halves.filter(
    (h): h is ResourceResult<BackgroundEntry[]> => h.status !== "unavailable",
  );
  for (const half of asked) {
    const found = mapResource(half, pick);
    if (found.status === "ready" && found.data !== null) return found;
  }
  const all = combineResources(
    Object.fromEntries(asked.map((h, i) => [String(i), h])),
  );
  return mapResource(all, () => null);
}
