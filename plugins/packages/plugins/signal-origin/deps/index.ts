// The signal tap's dependency: its compiled C shim, collected into infra/deps'
// registry through the `default` array (Settings → Dependencies,
// `./equin deps install signal-origin-shim`). The op commands ensure it
// before arming the tap.
import { signalOriginShim } from "./internal/shim";

export { signalOriginShim } from "./internal/shim";

export default [signalOriginShim];
