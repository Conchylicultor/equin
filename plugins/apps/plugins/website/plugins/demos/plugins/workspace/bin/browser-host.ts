// The workspace demo's browser host (the Agent Manager, Pages, Prototypes and Sonata on
// Demo's own equin): a worker booting the portable server graph inferred from
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
import workspaceSnapshot from "@browser-host-snapshot/apps/plugins/website/plugins/demos/plugins/workspace";
import { hostEntries } from "./browser-host.generated";

/** Where the demo keeps its data: one IndexedDB storage, whatever the build. */
const DEMO_STORAGE = "demo-workspace";

/** Told to the visitor whose older demo data this build replaced. */
const DEMO_UPDATED_NOTICE =
  "The demo was updated, so its data was reset to the new version.";

serveBrowserHost({
  // A worker's global scope: the repo's one lib types `self` as a Window.
  scope: self as unknown as WorkerScope,
  storage: {
    kind: "persistent",
    name: DEMO_STORAGE,
    migrations: bundledMigrations().map((m) => m.hash),
    // The demo's policy: its data is throwaway, so a visitor's data from an
    // older snapshot is replaced by this build's (and they are told).
    start: { snapshot: workspaceSnapshot, whenOutdated: "reset" },
  },
  async boot(storage) {
    const host = await bootBrowserHost({
      entries: hostEntries,
      onUnmatched: unmatchedApiResponse,
    });
    return {
      server: runtimeBrowserServer(host),
      keys: new Set(host.keys),
      boot: host.boot,
      ...(storage.origin.kind === "snapshot" && storage.origin.replacedOutdated
        ? { notice: DEMO_UPDATED_NOTICE }
        : {}),
    };
  },
});
