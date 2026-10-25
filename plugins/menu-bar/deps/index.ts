// The menu bar's dependency: the native helper (`equin-desktop`, the Tauri
// crate in rust/), collected into infra/deps' registry through the `default`
// array (`./equin deps install menu-bar-helper`). On macOS the build carries
// the app icon beside the binary; the login service runs it from the equin app
// bundle (infra/launcher/login-services), so notifications have that identity.
import { menuBarHelper } from "./internal/helper";

export { menuBarHelper, menuBarHelperIcon } from "./internal/helper";

export default [menuBarHelper];
