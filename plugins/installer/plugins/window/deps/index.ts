// The installer window's dependency: `equin-installer` (the wry/tao crate in
// rust/, its page from standalone-page/ compiled in), collected into infra/deps'
// registry through the `default` array (`./equin deps install installer-window`).
import { installerWindow } from "./internal/window";

export { installerWindow } from "./internal/window";
// The page as one HTML file, for a script that loads it without the window (e2e/replay.ts).
export { bundlePage } from "./internal/page";

export default [installerWindow];
