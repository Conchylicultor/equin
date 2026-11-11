// Shared CLI machinery, not a command (no default export): main's gateway as
// `./equin start` installs it, and main's follow-main restart of it (run by
// the convergence run, `./equin build --allow-main --converge`).
export { followMainGateway, withGatewayFollowLock } from "./internal/follow";
export type { GatewayFollowOutcome } from "./internal/follow";
export {
  adoptGatewayLaunch,
  holdGatewayBuild,
  prepareMainGateway,
} from "./internal/main-gateway";
export type { PreparedGateway } from "./internal/main-gateway";
