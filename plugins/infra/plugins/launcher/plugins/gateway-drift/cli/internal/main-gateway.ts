import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { envName } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { getMainRepoRoot } from "@plugins/infra/plugins/spawn/core";
import {
  ensureDep,
  holdDep,
  type Ready,
} from "@plugins/infra/plugins/deps/deps";
import type { BuildSource } from "@plugins/infra/plugins/deps/plugins/build/deps";
import { cliExecContext } from "@plugins/infra/plugins/jobs/plugins/supervised-job/cli";
import {
  GATEWAY_APP_COMPONENT,
  gatewayBinary,
  gatewayBuild,
} from "@plugins/infra/plugins/launcher/deps";
import {
  DEV_GATEWAY_PORT,
  devGatewayLaunchOptions,
  ensureDatabaseConfig,
  type GatewayLaunchOptions,
} from "@plugins/infra/plugins/launcher/server";
import {
  installServiceExecutable,
  plannedServiceExecutable,
  type MacosAppHost,
} from "@plugins/infra/plugins/launcher/plugins/login-services/machine";

/** The holder every install of the machine's gateway build is kept under. */
export const MACHINE_GATEWAY_HOLDER = "machine-gateway";

/** Main's gateway build, and the launch that would run it — nothing applied yet. */
export interface PreparedGateway {
  gateway: Ready<BuildSource>;
  launch: GatewayLaunchOptions;
}

/**
 * Ensure main's gateway binary and derive the launch options — every input to
 * a launch, nothing applied yet: the executable is where the build WOULD run
 * (inside the equin app bundle on macOS), not installed there. Built only when
 * main's gateway source (or Go) changed since the last build (the identity is
 * the source hash), so an unchanged one costs a hash. Shared by `./equin
 * start` and main's follow-main restart ({@link followMainGateway}), so both
 * install the one launch the health report's Gateway row compares against.
 */
export async function prepareMainGateway(opts: {
  logLevel: string;
  app: MacosAppHost;
  log: (line: string) => void;
}): Promise<PreparedGateway> {
  // The machine's gateway is MAIN's: built from the main checkout's Go source
  // whichever checkout asks.
  const repoRoot = await getMainRepoRoot();
  const gateway = await ensureDep(gatewayBinary, cliExecContext(), {
    root: repoRoot,
    log: opts.log,
  });
  opts.log(`Gateway binary: ${gateway.dir} (${gateway.identity})`);
  return {
    gateway,
    launch: {
      executable: plannedServiceExecutable(
        opts.app,
        GATEWAY_APP_COMPONENT,
        gatewayBuild(gateway),
      ),
      ...devGatewayLaunchOptions({ repoRoot, logLevel: opts.logLevel }),
    },
  };
}

/**
 * Apply a prepared launch before it runs: the binary installed into the equin
 * app bundle (macOS; re-signed there when this machine's identity changed) and
 * `database.json` written. Only on the paths that launch — swapping the
 * bundle's gateway is not a staleness report's to do, and the running
 * gateway's config is not this command's to change under it.
 *
 * It does not hold the build: a caller that can still go back holds it once
 * the new gateway answers ({@link holdGatewayBuild}), so the build the
 * running gateway came from stays held — and so restorable — until then.
 */
export async function adoptGatewayLaunch(
  { gateway, launch }: PreparedGateway,
  app: MacosAppHost,
  log: (line: string) => void,
): Promise<GatewayLaunchOptions> {
  const executable = await installServiceExecutable(
    app,
    GATEWAY_APP_COMPONENT,
    gatewayBuild(gateway),
    log,
  );
  await ensureDatabaseConfig(asAppPath(launch.cwd), log);
  log(
    launch.bindHost === null
      ? `Binding the gateway to every interface (${envName("LISTEN")}=:${DEV_GATEWAY_PORT})`
      : `Binding the gateway to ${launch.bindHost}:${DEV_GATEWAY_PORT}`,
  );
  return { ...launch, executable };
}

/**
 * Keep the build the machine's gateway runs from the deps sweep. Off macOS the
 * service job (and a detached gateway) names this binary by path long after
 * main's source moves on; on macOS the bundle is a copy, and the held build is
 * what a failed follow-main restart reinstalls. The next hold moves it.
 */
export async function holdGatewayBuild(
  gateway: Ready<BuildSource>,
): Promise<void> {
  await holdDep(gateway, MACHINE_GATEWAY_HOLDER);
}
