// Web-safe vocabulary of a per-user login service. The managers (launchd,
// systemd), `defineLoginService` and the declared registry are host-only and
// live in `machine/`.
export type {
  LoginServiceId,
  LoginServiceJob,
  LoginServiceSession,
  LoginServiceSpec,
} from "./internal/spec";
