// The playwright-browser installer kind of infra/deps, host-only like the
// engine: a declaration of a browser build Playwright pins
// (`playwrightBrowser`, in a feature's `deps/index.ts`) and the ways to
// launch it once installed (`launchChromium` / `launchPersistentChromium`, which take a `Ready`) or reach
// one another process bound (`connectChromium`).
export {
  connectChromium,
  launchChromium,
  launchPersistentChromium,
  playwrightBrowser,
} from "./internal/playwright-browser";
export type {
  ChromiumLaunchOptions,
  PersistentChromiumLaunchOptions,
  PlaywrightBrowserName,
  PlaywrightBrowserSource,
} from "./internal/playwright-browser";
