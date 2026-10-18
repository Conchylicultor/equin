import type { RoutesData } from "./types";

/** Diff projection: one route string per route, ordered server→machine→central then
 *  http→ws. Mirrors the legacy routeStrings() (compute-plugin-diff.ts) so the
 *  diff output is identical. `endpointCallers` is a derived reverse index (it
 *  changes based on OTHER plugins' route usage, not this plugin's authored
 *  routes), so it is intentionally excluded from a per-plugin diff. */
export function routesToComparable(data: RoutesData): string[] {
  const result: string[] = [];
  for (const runtime of ["server", "machine", "central"] as const) {
    for (const type of ["http", "ws"] as const) {
      for (const r of data.routes) {
        if (r.runtime === runtime && r.type === type) result.push(r.route);
      }
    }
  }
  return result;
}
