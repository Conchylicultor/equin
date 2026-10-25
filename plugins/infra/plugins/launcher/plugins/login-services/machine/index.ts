import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import { followMain } from "./internal/follow-main";

// Host-only: the service managers spawn launchctl / systemctl and write under
// the user's home. Reached by `./equin start` / `stop` (the CLI), by each
// plugin's `login-services/index.ts` declaration, and by main's boot
// (`onReady`), which brings every started service to main's build.
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
export { reconcileLoginService } from "./internal/reconcile";
export {
  appExecutablePath,
  bundleOfExecutable,
  installedAppComponents,
  installServiceExecutable,
  machineMacosAppHost,
  plannedServiceExecutable,
} from "./internal/macos-app";
export type { MacosAppHost } from "./internal/macos-app";
export { APP_BUNDLE_ID } from "./internal/macos-app-plist";
export type { InstalledComponent } from "./internal/macos-app-plist";
export type { ReconcileOutcome, ReconcilePolicy } from "./internal/reconcile";
export { awaitProcessGone, terminateProcess } from "./internal/process";
export type {
  InstalledJob,
  LoginService,
  LoginServiceManager,
  LoginServiceState,
} from "./internal/login-service";

export default {
  description:
    "Per-user login services, generalized from the gateway's: a LoginService over a LoginServiceSpec (label, argv, cwd, env, stdio log, session background | graphical), rendered as a launchd LaunchAgent on macOS (graphical → LimitLoadToSessionType=Aqua) or a systemd user unit on Linux (graphical → graphical-session.target, no lingering); defineLoginService and the collected login-services/ registry, so ./equin start / stop bring every declared service up and down without naming one. On main's boot, every declared service a start registered follows main: reloaded when main's build of its dependency changed its job (rewritten only, when stopped), the dependency requested through deps first when it is not built yet. On macOS every service (the gateway too) runs from ONE app bundle, equin.app (bundle id dev.equin, signed with the machine's identity, at a stable path under state/macos-app): installServiceExecutable copies a component's build in and swaps the re-signed bundle in whole, so every permission prompt, System Settings row and tccutil reset names one app, equin.",
  onReady: () => {
    // Main only: a worktree's checkout is not what the machine's services
    // run. Not awaited — an identity hash (or a build request) must not hold
    // boot; a rejection stays loud.
    if (!isMain()) return;
    void followMain();
  },
} satisfies MachinePluginDefinition;
