// The Lumen demo's browser host (the Agent Manager, Pages and Prototypes on
// one made-up story): a worker booting the portable server graph inferred from
// `./browser-host.composition.ts` on PGlite, served to every tab of the demo
// (one SharedWorker per build, where the browser has them). Its data is kept in
// the browser (`DEMO_STORAGE`): seeded once, on a fresh storage, then the
// visitor's own — until Reset wipes it and the next boot seeds again. Built by
// web-artifacts into the import map as `@browser-host/<this plugin>`.
import "./declare-namespace"; // MUST stay first: see the file.
import { runtimeBrowserServer } from "@plugins/framework/plugins/browser-server/core";
import {
  serveBrowserHost,
  type WorkerScope,
} from "@plugins/framework/plugins/browser-server/plugins/host-storage/core";
import { bootBrowserHost } from "@plugins/framework/plugins/server-core/core";
import { unmatchedApiResponse } from "@plugins/infra/plugins/endpoints/core";
import { bundledMigrations } from "@plugins/database/plugins/migrations/plugins/bundled-source/server";
import { hostEntries } from "./browser-host.generated";
import { seed } from "./seed";
import { bundledDemoPrototypes } from "./bundled-prototypes";

/** Where the demo keeps its data: one IndexedDB storage, whatever the build. */
const DEMO_STORAGE = "demo-lumen";

serveBrowserHost({
  // A worker's global scope: the repo's one lib types `self` as a Window.
  scope: self as unknown as WorkerScope,
  storage: {
    kind: "persistent",
    name: DEMO_STORAGE,
    migrations: bundledMigrations().map((m) => m.hash),
  },
  async boot(storage) {
    const host = await bootBrowserHost({
      entries: hostEntries,
      // The demo's policy: its story is written once, into a fresh storage.
      seed: storage.fresh ? () => seed(bundledDemoPrototypes()) : undefined,
      onUnmatched: unmatchedApiResponse,
    });
    return {
      server: runtimeBrowserServer(host),
      keys: new Set(host.keys),
      boot: host.boot,
    };
  },
});
