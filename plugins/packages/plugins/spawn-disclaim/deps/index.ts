// The disclaim helper's dependency: its compiled C program, collected into
// infra/deps' registry through the `default` array (Settings → Dependencies,
// `./equin deps install disclaim-exec`). The sdk runtime requests it at boot
// and resolves it at every agent launch.
import { disclaimExec } from "./internal/disclaim-exec";

export { disclaimExec } from "./internal/disclaim-exec";

export default [disclaimExec];
