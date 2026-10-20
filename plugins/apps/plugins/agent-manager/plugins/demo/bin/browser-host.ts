// The Agent Manager demo's browser host: a Web Worker booting the portable
// server graph of `./browser-host.plugins.ts` on PGlite, seeded with the
// demo's stories, served to the page over the worker's port. Built by
// web-artifacts into the import map as `@browser-host/<this plugin>`.
import {
  runtimeBrowserServer,
  serveOverPort,
  type PortEnd,
} from "@plugins/framework/plugins/browser-server/core";
import { bootBrowserHost } from "@plugins/framework/plugins/server-core/core";
import { unmatchedApiResponse } from "@plugins/infra/plugins/endpoints/core";
import { hostEntries } from "./browser-host.generated";
import { seed } from "./seed";

// A dedicated worker's global scope: the repo's one lib types `self` as a
// Window, whose `postMessage` takes a target origin.
const port = self as unknown as PortEnd;

void serveOverPort(port, async () => {
  const host = await bootBrowserHost({
    entries: hostEntries,
    seed,
    onUnmatched: unmatchedApiResponse,
  });
  return { server: runtimeBrowserServer(host), keys: new Set(host.keys) };
});
