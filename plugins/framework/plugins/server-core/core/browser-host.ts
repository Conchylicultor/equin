// The third composition root: the portable plugin graph booted inside a page's
// Web Worker, on whatever providers its entries carry (PGlite, the in-process
// job queue, memory stores). Beside `bin/index.ts` (the desktop's `serve`) and
// `cli/run-exec.ts` (`exec`), it runs the ONE boot sequence (`./boot-stages.ts`)
// in `browser` mode and hands back what a host serves: the request router and
// the live-state socket handler. Carrying them to the page (a MessagePort) is
// the caller's — `framework/browser-server`'s `serveOverPort`.
//
// What `browser` runs today: load waves, contributions, the host-service
// assert, `register`, the deferred bind, the preload assert and the
// `onReadyBlocking` barrier (migrations and the schema layer on the host's
// database) — exactly `exec`'s phases. The post-ready phases (`onReady`'s job
// runners, `onAllReady`'s schedules) do not run yet: the first slice serves
// seeded reads, and a background job firing in a demo is a write path the next
// slice turns on deliberately.

import { createRequestHandler } from "@plugins/framework/plugins/http-router/core";
import { bootPluginGraph, type ServerRegistryEntry } from "./boot-stages";
import { hostHttpRoutes } from "./host-routes";
import { notificationsWsHandler, Resource } from "./resources";

export interface BrowserHostOptions {
  /** The host's plugin graph — its generated `browser-host.generated.ts`. */
  entries: ServerRegistryEntry[];
  /**
   * Fill the freshly migrated database, after the ready barrier and before
   * anything is served: a demo's seed rows. Absent: the database starts empty.
   */
  seed?: () => Promise<void>;
}

export interface BrowserHost {
  /** One HTTP request through the graph's routes (`/api/resources/:key` included). */
  request(req: Request): Promise<Response>;
  /** The live-state socket (`/ws/notifications`): open / message / close over a `RuntimeSocket`. */
  notifications: typeof notificationsWsHandler;
  /** Every resource key the graph serves — what a page routes to this host. */
  keys: readonly string[];
}

export async function bootBrowserHost(
  opts: BrowserHostOptions,
): Promise<BrowserHost> {
  const ordered = await bootPluginGraph({
    mode: "browser",
    entries: opts.entries,
    // One bundle: every module it can reach is already in it, nothing to warm.
    hasCoreBarrel: () => false,
  });

  // The build proves the bundle reaches no platform module; this names the
  // claim per plugin, so a graph that boots a plugin nobody declared portable
  // fails here rather than at its first platform call.
  const unportable = ordered.filter((p) => p.portable !== true);
  if (unportable.length > 0) {
    throw new Error(
      `[browser-host] these plugins do not declare \`portable: true\`, so the browser cannot boot them: ${unportable.map((p) => p.id).join(", ")}`,
    );
  }
  // A plugin's own socket routes (`wsRoutes`, e.g. a log tail) are not served:
  // the page reaches this host through HTTP and the live-state socket only, and
  // its transport opens every other socket path inert (as it does central's).

  await opts.seed?.();

  const request = createRequestHandler({
    routes: hostHttpRoutes(ordered),
    onError: (err, req, pathname) => {
      console.error(
        `[browser-host] ${req.method} ${pathname}: ${err.message}`,
        err.stack ?? "",
      );
    },
  });
  return {
    request,
    notifications: notificationsWsHandler,
    keys: Resource.Declare.getContributions().map((c) => c.key),
  };
}
