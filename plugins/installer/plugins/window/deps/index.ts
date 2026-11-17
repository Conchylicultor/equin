// The installer window's dependency: `equin-installer` (the wry/tao crate in
// rust/, its page from standalone-page/ compiled in), collected into infra/deps'
// registry through the `default` array (`./equin deps install installer-window`).
import { installerWindow } from "./internal/window";

export { installerWindow } from "./internal/window";

export default [installerWindow];
