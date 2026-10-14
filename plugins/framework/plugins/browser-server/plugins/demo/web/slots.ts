import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";
import type { RouteHandler } from "@plugins/framework/plugins/http-router/core";
import type {
  BrowserServe,
  BrowserServed,
} from "@plugins/framework/plugins/browser-server/core";

/** A browser server's `serve` half: serve declarations on `s`, return what was served. */
export type DemoServe = (s: BrowserServe) => readonly BrowserServed[];

export const Demo = {
  /**
   * A plugin answering its own live keys inside every demo scope. `useServe`
   * runs once per scope mount, inside the scope's React tree (it may read
   * slots, config…), and returns the serve function the scope's browser server
   * calls when it is built. Return a STABLE function (read changing inputs
   * through a ref): a new identity rebuilds the scope's server. To push a
   * change later, keep what `s.serveValue` / `s.serveCollection` returned and
   * call its `notify()`.
   */
  Resource: defineSlot<{
    id: string;
    useServe: Hook<() => DemoServe>;
  }>({ docLabel: (c) => c.id }),
  /**
   * A plugin's in-browser handler for one of its endpoints, answered inside
   * every demo scope: `[ep.route, implement(ep, handler)]`.
   */
  Route: defineSlot<{
    route: readonly [key: string, handler: RouteHandler];
  }>({ docLabel: (c) => c.route[0] }),
};
