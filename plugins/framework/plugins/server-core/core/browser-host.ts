// The third composition root: the portable plugin graph booted inside a page's
// Web Worker, on whatever providers its entries carry (PGlite, the in-process
// job queue, memory stores). Beside `bin/index.ts` (the desktop's `serve`) and
// `cli/run-exec.ts` (`exec`), it runs the ONE boot sequence (`./boot-stages.ts`)
// in `browser` mode and hands back what a host serves: the request router and
// the live-state socket handler. Carrying them to the page (a MessagePort) is
// the caller's — `framework/browser-server`'s `serveOverPort`.
//
// What `browser` runs: load waves, contributions, the host-service assert,
// `register`, the deferred bind, the preload assert and the `onReadyBlocking`
// barrier (migrations and the schema layer on the host's database, the change
// feed's triggers); then the post-ready phases a serving host runs
// (`runPostReadyPhases`: the change-feed assertion, `onReady` — event trigger
// sync, the feed's LISTEN, the in-process job queue, the files watchers — and
// `onAllReady`'s schedules); then the seed; then the handler is returned. The
// same order `serve` runs, the seed in place of the socket bind, so the seed
// writes into a LIVE host: its writes fire the real triggers and jobs (a page
// write derives its links, search doc and history by itself; a file write is
// adopted by the watcher), exactly as a user's write would — the seed settles
// what it queued (`settleJobQueue`) rather than calling derivations by hand.
// The page cannot connect before the handler exists, so nothing is served
// mid-seed. Only `drainWarmups` (desktop warm-ups) is not run.

import { createRequestHandler } from "@plugins/framework/plugins/http-router/core";
import {
  bootPluginGraph,
  runPostReadyPhases,
  type ServerRegistryEntry,
} from "./boot-stages";
import { hostHttpRoutes } from "./host-routes";
import { getProfilingData } from "./profiler";
import {
  closeResourceKeySet,
  notificationsWsHandler,
  Resource,
} from "./resources";

export interface BrowserHostOptions {
  /** The host's plugin graph — its generated `browser-host.generated.ts`. */
  entries: ServerRegistryEntry[];
  /**
   * Fill the freshly booted host, after the post-ready phases (triggers synced,
   * the job queue and watchers running, so every write the seed makes derives
   * what a user's write would) and before anything is served: a demo's seed,
   * written through the apps' real write paths. Absent: the database starts
   * empty.
   */
  seed?: () => Promise<void>;
  /**
   * The answer to a request no route of the graph matches — pass
   * `infra/endpoints/core`'s `unmatchedApiResponse`, so an endpoint the graph
   * does not serve is the 409 unsupported refusal (the client recognises it
   * and says "not available here"), never a plain 404 it would report as a
   * missing route. An option rather than an import: `infra/endpoints` imports
   * server-core, so server-core cannot import it back (a plugin cycle).
   */
  onUnmatched: (req: Request, pathname: string) => Response;
}

export interface BrowserHost {
  /** One HTTP request through the graph's routes (`/api/resources/:key` included). */
  request(req: Request): Promise<Response>;
  /** The live-state socket (`/ws/notifications`): open / message / close over a `RuntimeSocket`. */
  notifications: typeof notificationsWsHandler;
  /** Every resource key the graph serves — what a page routes to this host. */
  keys: readonly string[];
  /** Where the boot spent its time, for the page to log. */
  boot: BrowserHostBoot;
}

/** How long one browser-host boot took, on the worker's clock. */
export interface BrowserHostBoot {
  /** Graph nodes booted (a plugin's server and machine halves count apart). */
  plugins: number;
  /** In order: `graph` (load → register → ready barrier, migrations included), `ready` (`onReady` → `onAllReady`), `seed`. */
  stages: { name: string; ms: number }[];
  /** The slowest plugin hooks of the boot (`register` / `onReadyBlocking` / `onReady` / `onAllReady`), longest first. */
  slowest: { label: string; ms: number }[];
}

/** How many of the slowest spans a boot reports. */
const SLOWEST_SPANS = 5;

export async function bootBrowserHost(
  opts: BrowserHostOptions,
): Promise<BrowserHost> {
  const t0 = performance.now();
  // A browser host ships with its only client (the page that loaded it), so a
  // key it does not register is never skew: closed before anything can serve.
  closeResourceKeySet();
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

  const t1 = performance.now();
  await runPostReadyPhases(ordered);
  const t2 = performance.now();
  await opts.seed?.();
  const t3 = performance.now();

  const request = createRequestHandler({
    routes: hostHttpRoutes(ordered),
    onError: (err, req, pathname) => {
      console.error(
        `[browser-host] ${req.method} ${pathname}: ${err.message}`,
        err.stack ?? "",
      );
    },
    onUnmatched: opts.onUnmatched,
  });
  return {
    request,
    notifications: notificationsWsHandler,
    keys: Resource.Declare.getContributions().map((c) => c.key),
    boot: {
      plugins: ordered.length,
      stages: [
        { name: "graph", ms: Math.round(t1 - t0) },
        { name: "ready", ms: Math.round(t2 - t1) },
        { name: "seed", ms: Math.round(t3 - t2) },
      ],
      // Per-plugin spans only (a phase-wide span would repeat its slowest
      // plugin), and none that took no time.
      slowest: getProfilingData()
        .spans.filter((s) => s.plugin !== undefined && s.durationMs > 0)
        .toSorted((a, b) => b.durationMs - a.durationMs)
        .slice(0, SLOWEST_SPANS)
        .map((s) => ({ label: s.id, ms: s.durationMs })),
    },
  };
}
