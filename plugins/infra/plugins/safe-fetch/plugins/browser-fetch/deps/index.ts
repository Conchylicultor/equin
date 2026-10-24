// Chromium, collected into infra/deps' registry through the `default` array
// (Settings → Dependencies, `./equin deps install chromium`). Launch it
// with the playwright-browser kind's `launchChromium(ready, …)`.
import { chromium } from "./internal/chromium";

export { chromium } from "./internal/chromium";

export default [chromium];
