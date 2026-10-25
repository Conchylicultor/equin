import { existsSync, readFileSync } from "node:fs";
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
  GATEWAY_SERVICE,
  gatewayLaunchFlags,
  isRunning,
  readPid,
} from "@plugins/infra/plugins/launcher/server";
import { componentIdentity } from "@plugins/infra/plugins/launcher/plugins/login-services/core";
import {
  APP_BUNDLE_ID,
  bundleOfExecutable,
  installedAppComponents,
  loginService,
  machineMacosAppHost,
  plannedServiceExecutable,
  type MacosAppHost,
} from "@plugins/infra/plugins/launcher/plugins/login-services/machine";
import type { GatewayDrift } from "../../core";
import { binaryIdentity, diffGatewayFlags, flagValue } from "./diff";

const PS_TIMEOUT_MS = 10_000;

/**
 * Compare the machine's gateway with what `./equin start --force` would
 * install now: the installed service definition's argv and cwd against main's
 * (`devGatewayLaunchOptions` + `gatewayLaunchFlags` — the derivation `start`
 * writes, with `-log-level` taken from the installed argv since it is
 * `start`'s flag), its binary against main's `gateway-binary` build, the
 * binary's signature, and the running gateway's command line against the
 * installed one.
 *
 * The environment is not compared: the definition's is the STARTER's
 * (`pickRuntimeEnv` of the shell that ran `start`), which no backend can
 * rebuild. A newly declared runtime name still shows, through `-child-env`.
 */
export async function checkGatewayDrift(): Promise<GatewayDrift> {
  if (isRelease()) {
    return notApplicable("A release runs the gateway its bundle sealed");
  }
  const service = loginService(GATEWAY_SERVICE);
  if (service === null) {
    return notApplicable(
      "This machine has no service manager: the gateway is started by hand",
    );
  }
  const installed = service.installedJob();
  if (installed === null) {
    return notApplicable(
      existsSync(service.definitionPath())
        ? `The gateway's ${service.manager} definition was not written by ./equin start`
        : `The gateway is not registered with ${service.manager} on this machine`,
    );
  }

  const repoRoot = await getMainRepoRoot();
  const [installedBinary = "", ...installedFlags] = installed.argv;
  const expectedFlags = gatewayLaunchFlags(
    devGatewayLaunchOptions({
      repoRoot,
      logLevel:
        flagValue(installedFlags, "-log-level") ?? DEV_GATEWAY_LOG_LEVEL,
    }),
  );
  // A definition naming another data root's pidfile is not the gateway this
  // backend runs behind (a preview under its own EQUIN_DIR).
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
  const differences: string[] = [];
  const binary = await describeBinary(installedBinary, repoRoot, app);
  if (binary !== null) differences.push(binary);
  differences.push(...diffGatewayFlags(installedFlags, expectedFlags));
  if (installed.cwd !== repoRoot) {
    differences.push(`working directory ${installed.cwd} → ${repoRoot}`);
  }
  const signature =
    bundle === null
      ? await gatewaySignature(installedBinary)
      : await codeSignature(bundle, APP_BUNDLE_ID);
  if (signature === "unsigned") {
    differences.push(
      bundle === null
        ? "binary not signed by this machine's identity"
        : "equin app not signed by this machine's identity",
    );
  } else if (signature === "no-identity") {
    differences.push("no stable signing identity on this machine yet");
  }
  const running = await runningCommand();
  if (running !== null && running !== installed.argv.join(" ")) {
    differences.push(
      `the running gateway was started with another command than the installed ${service.manager} one`,
    );
  }
  return differences.length === 0
    ? { kind: "current" }
    : { kind: "stale", differences };
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
  repoRoot: string,
  app: MacosAppHost,
): Promise<string | null> {
  const now = await readyNow(gatewayBinary, { root: repoRoot });
  const was = installedIdentity(installedBinary, app) ?? installedBinary;
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
function installedIdentity(path: string, app: MacosAppHost): string | null {
  const bundle = bundleOfExecutable(app.bundle, path);
  if (bundle !== null) {
    return (
      installedAppComponents(bundle)?.find(
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
  const pid = readPid();
  if (pid === null || !isRunning(pid)) return null;
  const proc = `/proc/${pid}/cmdline`;
  if (existsSync(proc)) {
    return readFileSync(proc, "utf-8").replace(/\0$/, "").split("\0").join(" ");
  }
  const res = await spawnCaptured(
    ["ps", "-ww", "-o", "args=", "-p", `${pid}`],
    {
      timeoutMs: PS_TIMEOUT_MS,
    },
  );
  return res.exitCode === 0 ? res.stdout.trim() : null;
}

function notApplicable(reason: string): GatewayDrift {
  return { kind: "not-applicable", reason };
}
