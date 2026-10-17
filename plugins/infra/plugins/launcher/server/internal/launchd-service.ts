import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  spawnCaptured,
  spawnExpectOk,
  SpawnFailedError,
} from "@plugins/infra/plugins/spawn/core";
import { HOME_DIR } from "@plugins/infra/plugins/paths/core";
import { retryUntil, exponential } from "@plugins/packages/plugins/retry/core";
import { renderLaunchAgentPlist } from "./launchd-plist";
import type { gatewayLaunchSpec } from "./boot";
import {
  GATEWAY_SERVICE_LABEL,
  type GatewayLoginService,
  type GatewayServiceState,
} from "./gateway-service";

/**
 * The gateway as a per-user launchd service (macOS).
 *
 * A LaunchAgent in the user's `gui/<uid>` domain, not a boot-time LaunchDaemon:
 * the secrets master key lives in the login keychain, locked until the user
 * logs in, and the runtime is one instance per user anyway. So the gateway —
 * and through its supervisor Postgres, PgBouncer and every backend — starts at
 * login (immediately with auto-login) and is relaunched by launchd if it dies.
 *
 * launchd runs at most one instance of a label, so a restart through it can
 * never overlap two gateway generations.
 */

function gatewayServicePlistPath(): string {
  return join(
    HOME_DIR,
    "Library",
    "LaunchAgents",
    `${GATEWAY_SERVICE_LABEL}.plist`,
  );
}

function domain(): string {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("launchd service needs a POSIX uid");
  return `gui/${uid}`;
}

function serviceTarget(): string {
  return `${domain()}/${GATEWAY_SERVICE_LABEL}`;
}

const LAUNCHCTL_TIMEOUT_MS = 30_000;
// `launchctl print` of a label the domain does not have.
const LAUNCHCTL_NO_SUCH_SERVICE = 113;

/** What launchd currently holds for the gateway label. */
async function gatewayServiceState(): Promise<GatewayServiceState> {
  const argv = ["launchctl", "print", serviceTarget()];
  const res = await spawnCaptured(argv, { timeoutMs: LAUNCHCTL_TIMEOUT_MS });
  if (res.exitCode === LAUNCHCTL_NO_SUCH_SERVICE) return { kind: "not-loaded" };
  if (res.exitCode !== 0) {
    throw new SpawnFailedError(
      argv,
      res.exitCode,
      res.signalCode,
      res.stdout,
      res.stderr,
    );
  }
  // Top-level properties are indented by exactly one tab; nested blocks
  // (environment, endpoints, …) by more, so anchoring on one tab reads the
  // service's own fields only.
  const pid = /^\tpid = (\d+)$/m.exec(res.stdout)?.[1];
  const lastExit = /^\tlast exit code = (.+)$/m.exec(res.stdout)?.[1];
  return {
    kind: "loaded",
    pid: pid === undefined ? null : Number(pid),
    lastExit: lastExit ?? null,
  };
}

/**
 * Write the LaunchAgent plist for `spec`. launchd reads a plist only when it is
 * bootstrapped, so a changed plist takes effect on the next `bootout` +
 * `bootstrap` (or the next login).
 */
function writeGatewayServicePlist(spec: ReturnType<typeof gatewayLaunchSpec>): {
  path: string;
  changed: boolean;
} {
  const path = gatewayServicePlistPath();
  const content = renderLaunchAgentPlist({
    label: GATEWAY_SERVICE_LABEL,
    argv: spec.argv,
    cwd: spec.cwd,
    env: spec.env,
    stdioLog: spec.stdioLog,
  });
  const before = existsSync(path) ? readFileSync(path, "utf-8") : null;
  if (before === content) return { path, changed: false };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode: 0o600 });
  return { path, changed: true };
}

/** Delete the plist, so the gateway no longer starts at login. */
function removeGatewayServicePlist(): boolean {
  const path = gatewayServicePlistPath();
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

/**
 * Load the plist into launchd, which starts the gateway (RunAtLoad) and returns
 * its pid once launchd reports one.
 *
 * Fails loudly when there is no GUI login session for this user (e.g. a bare
 * SSH login on a Mac nobody is logged into): launchctl's own error says so.
 */
async function bootstrapGatewayService(): Promise<number> {
  await spawnExpectOk(
    ["launchctl", "bootstrap", domain(), gatewayServicePlistPath()],
    { timeoutMs: LAUNCHCTL_TIMEOUT_MS },
  );
  let lastExit: string | null = null;
  return retryUntil(
    async () => {
      const state = await gatewayServiceState();
      if (state.kind !== "loaded") return null;
      lastExit = state.lastExit;
      return state.pid;
    },
    {
      delay: exponential({ initial: 100, max: 1_000 }),
      deadline: 15_000,
      onDeadline: () => {
        throw new Error(
          `launchd loaded ${GATEWAY_SERVICE_LABEL} but it is not running (last exit: ${lastExit ?? "none"}); see \`launchctl print ${serviceTarget()}\``,
        );
      },
    },
  );
}

/**
 * Unload the gateway from launchd — launchd SIGTERMs it (SIGKILL after the
 * plist's ExitTimeOut). The plist stays, so the next login loads it again.
 */
async function bootoutGatewayService(): Promise<void> {
  await spawnExpectOk(["launchctl", "bootout", serviceTarget()], {
    timeoutMs: LAUNCHCTL_TIMEOUT_MS,
  });
}

export const launchdGatewayService: GatewayLoginService = {
  manager: "launchd",
  startsAt: "login",
  definitionPath: gatewayServicePlistPath,
  state: gatewayServiceState,
  write: writeGatewayServicePlist,
  remove: async () => removeGatewayServicePlist(),
  load: bootstrapGatewayService,
  unload: bootoutGatewayService,
};
