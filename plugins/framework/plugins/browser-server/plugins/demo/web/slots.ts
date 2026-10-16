import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";
import type { RouteHandler } from "@plugins/framework/plugins/http-router/core";
import type {
  BrowserServe,
  BrowserServed,
} from "@plugins/framework/plugins/browser-server/core";

/** A browser server's `serve` half: serve declarations on `s`, return what was served. */
export type DemoServe = (s: BrowserServe) => readonly BrowserServed[];

/** One endpoint handler: `[ep.route, implement(ep, handler)]`. */
export type DemoRoute = readonly [key: string, handler: RouteHandler];

/**
 * A plugin's backend inside ONE demo scope: what it serves, and the endpoint
 * handlers that share its state (a write handler notifying what `serve`
 * served). Both are built by the same `useBackend` call, so a plugin's
 * per-scope state (config's in-memory user layer) lives exactly as long as the
 * scope's mount.
 */
export interface DemoBackend {
  serve: DemoServe;
  routes?: readonly DemoRoute[];
}

export const Demo = {
  /**
   * A plugin answering its own live keys (and, optionally, its own endpoints)
   * inside every demo scope. `useBackend` runs once per scope mount, inside the
   * scope's React tree (it may read slots, config…), and returns the
   * `DemoBackend` the scope's browser server is built from. Return a STABLE
   * object (read changing inputs through a ref): a new identity rebuilds the
   * scope's server. To push a change later, keep what `s.serveValue` /
   * `s.serveCollection` returned and call its `notify()`.
   */
  Resource: defineSlot<{
    id: string;
    useBackend: Hook<() => DemoBackend>;
  }>({ docLabel: (c) => c.id }),
  /**
   * A plugin's STATELESS in-browser handler for one of its endpoints, answered
   * inside every demo scope: `[ep.route, implement(ep, handler)]`. A handler
   * with per-scope state is a `DemoBackend` route instead.
   */
  Route: defineSlot<{
    route: DemoRoute;
  }>({ docLabel: (c) => c.route[0] }),
};

/**
 * A `Demo.Resource` whose answers depend on nothing in the scope's tree — a
 * plugin's neutral demo answer ("no ops in flight", "no notes"), the same for
 * every scenario. `serve` is module-level, so it is stable by construction.
 */
export function demoResource(
  id: string,
  serve: DemoServe,
): ReturnType<typeof Demo.Resource> {
  const backend: DemoBackend = { serve };
  const useBackend = (): DemoBackend => backend;
  return Demo.Resource({ id, useBackend });
}
