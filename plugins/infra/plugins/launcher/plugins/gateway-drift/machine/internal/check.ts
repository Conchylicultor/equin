import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { exists, readFile } from "@plugins/packages/plugins/timed-fs/core";
import { codeSignature } from "@plugins/infra/plugins/codesign/deps";
import { readyNow } from "@plugins/infra/plugins/deps/deps";
import { isRelease } from "@plugins/infra/plugins/paths/core";
import {
  getMainRepoRoot,
  spawnCaptured,
} from "@plugins/infra/plugins/spawn/core";
import {
  GATEWAY_APP_COMPONENT,
  gatewayBinary,
  gatewayBuild,
  gatewaySignature,
} from "@plugins/infra/plugins/launcher/deps";
import {
  DEV_GATEWAY_LOG_LEVEL,
  devGatewayLaunchOptions,
  gatewayLaunchFlags,
  isRunning,
  readPid,
} from "@plugins/infra/plugins/launcher/server";
import { GATEWAY_SERVICE } from "@plugins/infra/plugins/launcher/core";
import { principalStamp } from "@plugins/framework/plugins/principal/core";
import { componentIdentity } from "@plugins/infra/plugins/launcher/plugins/login-services/core";
import {
  APP_BUNDLE_ID,
  bundleOfExecutable,
  installedAppComponents,
  loginService,
  machineMacosAppHost,
  plannedServiceExecutable,
  type InstalledJob,
  type LoginService,
  type MacosAppHost,
} from "@plugins/infra/plugins/launcher/plugins/login-services/machine";
import type { GatewayDrift } from "../../core";
import { binaryIdentity, diffGatewayFlags, flagValue } from "./diff";

const PS_TIMEOUT_MS = 10_000;

/**
 * The machine's gateway against what `./equin start --force` would install
 * now: {@link compareGatewayLaunch}'s differences, plus whether the running
 * gateway stamps the principal — read off THIS backend's own argv, so only a
 * backend can say it (the follow-main restart in a CLI does not ask).
 */
export async function checkGatewayDrift(): Promise<GatewayDrift> {
  const compared = await compareGatewayLaunch();
  if (compared.kind === "not-applicable") return compared;
  const differences = [...compared.differences];
  // The running gateway's own declaration, as this backend received it: no
  // --principal-stamped means it predates the principal stamp, so this
  // backend serves every route ungated (framework/principal, core/stamp.ts).
  if (principalStamp() === "unstamped") {
    differences.push(
      "the running gateway does not stamp the principal: cross-site requests are not refused",
    );
  }
  return differences.length === 0
    ? { kind: "current" }
    : { kind: "stale", differences };
}

/** What {@link compareGatewayLaunch} found. */
export type GatewayLaunchComparison =
  | { kind: "not-applicable"; reason: string }
  | {
      kind: "compared";
      /** The gateway's login service, bound to its installed label. */
      service: LoginService;
      /** The installed definition's launch, read back. */
      installed: InstalledJob;
      /** Main's checkout: what `start` builds the gateway from and runs it in. */
      repoRoot: AppPath;
      /** The installed `-log-level` (a `start` flag), kept by a reinstall. */
      logLevel: string;
      /** One short phrase per difference; empty when current. */
      differences: string[];
    };

/**
 * Compare the machine's gateway with what `./equin start --force` would
 * install now: the installed service definition's argv and cwd against main's
 * (`devGatewayLaunchOptions` + `gatewayLaunchFlags` — the derivation `start`
 * writes, with `-log-level` taken from the installed argv since it is
 * `start`'s flag), its binary against main's `gateway-binary` build, the
 * binary's signature, and the running gateway's command line against the
 * installed one. The one definition of "current" — the health report's row
 * and main's follow-main restart (`gateway-drift/cli`) both ask it.
 *
 * The environment is not compared: the definition's is the STARTER's
 * (`pickRuntimeEnv` of the shell that ran `start`), which no backend can
 * rebuild. A newly declared runtime name still shows, through `-child-env`.
 */
export async function compareGatewayLaunch(): Promise<GatewayLaunchComparison> {
  if (isRelease()) {
    return notApplicable("A release runs the gateway its bundle sealed");
  }
  const service = await loginService(GATEWAY_SERVICE);
  if (service === null) {
    return notApplicable(
      "This machine has no service manager: the gateway is started by hand",
    );
  }
  // Main's checkout is read beside the installed definition, not after it.
  const [installed, repoRoot] = await Promise.all([
    service.installedJob(),
    getMainRepoRoot(),
  ]);
  if (installed === null) {
    return notApplicable(
      (await exists(service.definitionPath()))
        ? `The gateway's ${service.manager} definition was not written by ./equin start`
        : `The gateway is not registered with ${service.manager} on this machine`,
    );
  }

  const [installedBinary = "", ...installedFlags] = installed.argv;
  const logLevel =
    flagValue(installedFlags, "-log-level") ?? DEV_GATEWAY_LOG_LEVEL;
  const expectedFlags = gatewayLaunchFlags(
    devGatewayLaunchOptions({ repoRoot, logLevel }),
  );
  // A definition naming another data root's pidfile is not the gateway this
  // process runs beside (a preview under its own EQUIN_DIR).
  if (
    flagValue(installedFlags, "-pid-file") !==
    flagValue(expectedFlags, "-pid-file")
  ) {
    return notApplicable(
      "This app does not run behind the machine's login-service gateway",
    );
  }

  // Read only (where the bundle is, what it holds): nothing is installed or
  // signed here, so the host is given no signing tool.
  const app = machineMacosAppHost(null, () => {});
  const bundle = bundleOfExecutable(app.bundle, installedBinary);
  // The binary's build, its signature and the running gateway's command line
  // are independent reads, each a process spawn or a source hash that waits
  // on a busy host: asked together, the comparison costs the slowest, not
  // their sum.
  const [binary, signature, running] = await Promise.all([
    describeBinary(installedBinary, repoRoot, app),
    bundle === null
      ? gatewaySignature(installedBinary)
      : codeSignature(bundle, APP_BUNDLE_ID),
    runningCommand(),
  ]);
  const differences: string[] = [];
  if (binary !== null) differences.push(binary);
  differences.push(...diffGatewayFlags(installedFlags, expectedFlags));
  if (installed.cwd !== repoRoot) {
    differences.push(`working directory ${installed.cwd} → ${repoRoot}`);
  }
  if (signature === "unsigned") {
    differences.push(
      bundle === null
        ? "binary not signed by this machine's identity"
        : "equin app not signed by this machine's identity",
    );
  } else if (signature === "no-identity") {
    differences.push("no stable signing identity on this machine yet");
  }
  if (running !== null && running !== installed.argv.join(" ")) {
    differences.push(
      `the running gateway was started with another command than the installed ${service.manager} one`,
    );
  }
  return {
    kind: "compared",
    service,
    installed,
    repoRoot,
    logLevel,
    differences,
  };
}

/**
 * How the installed binary differs from main's `gateway-binary` build, or null
 * when it is that build, where `start` would run it (inside the equin app on
 * macOS). Main's build may not exist yet (its source moved and nothing built
 * it): the installed one is then older by definition — `start --force` builds
 * it.
 */
async function describeBinary(
  installedBinary: string,
  repoRoot: AppPath,
  app: MacosAppHost,
): Promise<string | null> {
  const [now, installedAs] = await Promise.all([
    readyNow(gatewayBinary, { root: repoRoot }),
    installedIdentity(installedBinary, app),
  ]);
  const was = installedAs ?? installedBinary;
  switch (now.kind) {
    case "ready": {
      const expected = plannedServiceExecutable(
        app,
        GATEWAY_APP_COMPONENT,
        gatewayBuild(now.ready),
      );
      if (installedBinary !== expected.path) {
        return expected.bundled
          ? "runs outside the equin app (its permissions are a bare binary's)"
          : `binary at ${installedBinary}, not ${expected.path}`;
      }
      if (was === expected.identity) return null;
      return `binary built from older gateway source (${short(was)} → ${short(expected.identity)})`;
    }
    case "failed":
      return `main's gateway does not build (${now.message})`;
    case "absent":
    case "installing":
      return `binary built from older gateway source (${short(was)}; main's is not built yet)`;
  }
}

/**
 * Which gateway build the installed job runs: the build the equin app records
 * for its `gateway` component, or the one a deps-cache path names; null when
 * neither says.
 */
async function installedIdentity(
  path: string,
  app: MacosAppHost,
): Promise<string | null> {
  const bundle = bundleOfExecutable(app.bundle, path);
  if (bundle !== null) {
    return (
      (await installedAppComponents(bundle))?.find(
        (c) => c.name === GATEWAY_APP_COMPONENT.name,
      )?.identity ?? null
    );
  }
  const identity = binaryIdentity(path);
  return identity === null
    ? null
    : componentIdentity(gatewayBinary.id, identity);
}

/** A build identity, shortened for the summary (without its `<dep>@` prefix). */
function short(identity: string): string {
  const bare = identity.slice(identity.indexOf("@") + 1);
  return bare.length > 12 ? bare.slice(0, 8) : bare;
}

/**
 * The running gateway's command line, space-joined (how `ps` prints it), or
 * null when no gateway is running under the pidfile.
 */
async function runningCommand(): Promise<string | null> {
  const pid = await readPid();
  if (pid === null || !isRunning(pid)) return null;
  const proc = `/proc/${pid}/cmdline`;
  if (await exists(proc)) {
    return (await readFile(proc, "utf-8"))
      .replace(/\0$/, "")
      .split("\0")
      .join(" ");
  }
  const res = await spawnCaptured(
    ["ps", "-ww", "-o", "args=", "-p", `${pid}`],
    {
      timeoutMs: PS_TIMEOUT_MS,
    },
  );
  return res.exitCode === 0 ? res.stdout.trim() : null;
}

function notApplicable(reason: string): {
  kind: "not-applicable";
  reason: string;
} {
  return { kind: "not-applicable", reason };
}
