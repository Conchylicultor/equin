import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";

// Host-only: the service managers spawn launchctl / systemctl and write under
// the user's home. Reached by `./equin start` / `stop` (the CLI) and by each
// plugin's `login-services/index.ts` declaration.
export {
  defineLoginService,
  loginServiceHolder,
  loginServiceId,
  loginServiceJob,
} from "./internal/define";
export type {
  DefineLoginServiceSpec,
  LoginServiceDeclaration,
  LoginServiceRun,
} from "./internal/define";
export { declaredLoginServices } from "./internal/registry";
export { loginService, loginServiceManager } from "./internal/host";
export type {
  LoginService,
  LoginServiceManager,
  LoginServiceState,
} from "./internal/login-service";

export default {
  description:
    "Per-user login services, generalized from the gateway's: a LoginService over a LoginServiceSpec (label, argv, cwd, env, stdio log, session background | graphical), rendered as a launchd LaunchAgent on macOS (graphical → LimitLoadToSessionType=Aqua) or a systemd user unit on Linux (graphical → graphical-session.target, no lingering); defineLoginService and the collected login-services/ registry, so ./equin start / stop bring every declared service up and down without naming one.",
} satisfies MachinePluginDefinition;
