import { defineDep } from "@plugins/infra/plugins/deps/deps";
import {
  playwrightBrowser,
  playwrightSystemPackages,
} from "@plugins/infra/plugins/deps/plugins/playwright-browser/deps";

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
  // Linux: the browser runs against system libraries (NSS, ATK, libgbm,
  // ALSA, …) a server image does not ship. Playwright knows the list per
  // distribution release, so it checks and installs them. Every install
  // prepares them: the browser itself is installed on demand, and the first
  // to need it is usually main's unattended deploy, which cannot ask for a
  // password.
  systemPackages: {
    linux: playwrightSystemPackages({
      browser: "chromium",
      forUser: "the system libraries the Chromium browser runs on",
    }),
    everyInstall:
      "main's deploy checks the app's layout in it (the layout-geometry check), and that deploy cannot ask for a password",
  },
  updates: {
    none: "follows the playwright npm package, which the npm updater moves",
  },
});
