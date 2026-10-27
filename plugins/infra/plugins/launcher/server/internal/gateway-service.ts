import type { LoginServiceJob } from "@plugins/infra/plugins/launcher/plugins/login-services/core";
import type { gatewayLaunchSpec } from "./boot";

/** The gateway's job definition: its one launch spec, as a service runs it. */
export function gatewayServiceJob(
  spec: ReturnType<typeof gatewayLaunchSpec>,
): LoginServiceJob {
  return {
    description:
      "equin gateway (and through it Postgres, PgBouncer and every backend)",
    argv: spec.argv,
    cwd: spec.cwd,
    env: spec.env,
    stdioLog: spec.stdioLog,
  };
}
