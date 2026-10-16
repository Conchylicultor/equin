import { defineDep } from "@plugins/infra/plugins/deps/deps";
import { playwrightBrowser } from "@plugins/infra/plugins/deps/plugins/playwright-browser/deps";

/**
 * The Chromium every browser launch in the repo runs: `browserFetch` and the
 * prototype thumbnails (request / job paths: `readyNow` + `requestDep`), the
 * layout-geometry check and the e2e harness (`ensureDepViaCli`). Declared here
 * because the primitive that needs it at run time owns it — a backend's
 * correctness must not depend on a tooling plugin's declaration.
 *
 * On demand: nothing downloads it at `bun install`. The first thing that needs
 * it installs it (~280 MB) into the deps cache, once per machine per
 * `playwright-core` version.
 */
export const chromium = defineDep({
  id: "chromium",
  owner: "infra/safe-fetch/browser-fetch",
  description:
    "Headless Chromium (and its headed pair) for browser-backed page reads, prototype thumbnails, the layout-geometry check and e2e scripts",
  sizeHint: "≈600 MB",
  source: playwrightBrowser({ browser: "chromium" }),
  updates: {
    none: "follows the playwright npm package, which the npm updater moves",
  },
});
