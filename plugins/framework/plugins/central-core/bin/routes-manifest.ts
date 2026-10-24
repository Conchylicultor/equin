import { renameSync, writeFileSync } from "node:fs";
import {
  CENTRAL_ROUTES_FILENAME,
  gatewayState,
} from "@plugins/infra/plugins/launcher/data-dirs";

/**
 * The name the gateway knows this backend by. It must match the gateway's
 * registry entry for central (`central.json`, see gateway/worktree.go).
 */
const CENTRAL_BACKEND = "central";

/**
 * The path prefixes the gateway must forward to central, derived from the
 * routes this process registered.
 *
 * An HTTP route key is method-prefixed (`"POST /api/auth/sign-in/:provider"`):
 * the method is dropped and the path is cut at its first `/:param`, leaving a
 * prefix the gateway can match (`/api/auth/sign-in/`). A path with no param is
 * kept whole. WebSocket routes are literal paths and are kept as-is.
 */
export function centralRoutePrefixes(
  httpRouteKeys: Iterable<string>,
  wsPaths: Iterable<string>,
): string[] {
  const out = new Set<string>();
  for (const key of httpRouteKeys) {
    const space = key.indexOf(" ");
    const path = space >= 0 ? key.slice(space + 1) : key;
    const param = path.indexOf("/:");
    out.add(param >= 0 ? path.slice(0, param + 1) : path);
  }
  for (const path of wsPaths) out.add(path);
  return [...out].sort();
}

/**
 * Publish the routing manifest the gateway watches
 * (`state/gateway/central-routes.json`).
 *
 * Central writes it itself, on every boot, from the routes it actually serves.
 * It used to be written by every checkout's `./equin build` from that
 * checkout's own tree — so a worktree on an older branch silently dropped a
 * route main's central was serving, and the gateway then sent those requests
 * to a worktree backend that answered "Not found".
 *
 * Atomic (temp file + rename): the gateway reloads on change and must never
 * read a half-written file.
 */
export function writeCentralRoutesManifest(routes: readonly string[]): void {
  gatewayState.ensure();
  const file = gatewayState.file(CENTRAL_ROUTES_FILENAME);
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(
    tmp,
    JSON.stringify({ backend: CENTRAL_BACKEND, routes }, null, 2) + "\n",
  );
  renameSync(tmp, file);
}
