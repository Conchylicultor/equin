// The menu bar's dependency: the native helper (`equin-desktop`, the Tauri
// crate in rust/), collected into infra/deps' registry through the `default`
// array (`./equin deps install menu-bar-helper`). On macOS it is an `equin.app`
// around the binary, so notifications have a bundle identity.
import { menuBarHelper } from "./internal/helper";

export { menuBarHelper } from "./internal/helper";

export default [menuBarHelper];
