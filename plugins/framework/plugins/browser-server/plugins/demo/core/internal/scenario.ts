import type { ScopedComposition } from "@plugins/framework/plugins/web-sdk/core";

/**
 * A demo's browser host, as its owner's codegen emits it
 * (`core/browser-host.generated.ts`, `browserHost`): the composition the
 * worker boots — its id, home and web plugins, the scope the page renders the
 * demo's subtree in (`<PluginScope>`) — and the worker's start
 * (`import("@browser-host/<plugin path>")`). One derivation writes both, so
 * the page shows exactly the plugins the worker serves.
 */
export type DemoHost = ScopedComposition & {
  start(): Promise<{ start(): Worker }>;
};

/**
 * A demo: the app it shows, the route it opens at, and the browser host its
 * story is served from. Declared by the app's owner (`apps/<app>/plugins/demo`),
 * so nothing generic names a scenario.
 */
export interface DemoScenario {
  id: string;
  /** The `Apps.App` id the demo renders (an `<AppEmbed app>`). */
  app: string;
  /** The app-relative route it opens at (`/c/<id>`). */
  route: string;
  /**
   * The scenario's browser host: a Web Worker running real server code on an
   * in-browser database seeded with the scenario's story, and the composition
   * scope the page renders the demo in. It answers every read and request in
   * the demo: a key it does not serve fails `loader-failed` (its key set is
   * closed), an endpoint it does not implement is refused unsupported.
   */
  host: DemoHost;
}
