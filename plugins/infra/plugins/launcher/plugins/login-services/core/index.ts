// Web-safe vocabulary of a per-user login service. The managers (launchd,
// systemd), `defineLoginService`, the declared registry and the macOS app
// bundle are host-only and live in `machine/`.
export type {
  LoginServiceId,
  LoginServiceJob,
  LoginServiceSession,
  LoginServiceSpec,
} from "./internal/spec";
export {
  componentIdentity,
  executableEnv,
  unbundledExecutable,
} from "./internal/app-component";
export type {
  AppComponent,
  ComponentBuild,
  ServiceExecutable,
} from "./internal/app-component";
