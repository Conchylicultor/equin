import type {
  LoginServiceId,
  LoginServiceJob,
} from "@plugins/infra/plugins/launcher/plugins/login-services/core";
import type { gatewayLaunchSpec } from "./boot";

/**
 * The gateway as a per-user OS service — what makes the app come back after a
 * reboot and relaunches the gateway when it dies. One login service among
 * those `./equin start` brings up (`launcher/login-services`), but not a
 * declared one: it is the service every other one needs, `start` gates on it
 * answering, hands over a gateway started outside the manager, and builds its
 * launch from flags (`--log-level`, the bind host). So `start` drives it by
 * this id and job explicitly, through the same `LoginService` a declared
 * service gets.
 *
 * `background`: it runs with nobody at the screen (systemd: at boot, given
 * lingering), and its rendered plist / unit is exactly the pre-generic one.
 */
export const GATEWAY_SERVICE: LoginServiceId = {
  label: "dev.singularity.gateway",
  session: "background",
};

/** The gateway's job definition: its one launch spec, as a service runs it. */
export function gatewayServiceJob(
  spec: ReturnType<typeof gatewayLaunchSpec>,
): LoginServiceJob {
  return {
    description:
      "Singularity gateway (and through it Postgres, PgBouncer and every backend)",
    argv: spec.argv,
    cwd: spec.cwd,
    env: spec.env,
    stdioLog: spec.stdioLog,
  };
}
