import { join } from "node:path";
import {
  spawnCaptured,
  spawnExpectOk,
  SpawnFailedError,
} from "@plugins/infra/plugins/spawn/core";
import { HOME_DIR } from "@plugins/infra/plugins/paths/core";
import { retryUntil, exponential } from "@plugins/packages/plugins/retry/core";
import type { LoginServiceId } from "../../core";
import { removeDefinition, writeDefinition } from "./definition-file";
import { renderLaunchAgentPlist } from "./launchd-plist";
import type {
  LoginService,
  LoginServiceManager,
  LoginServiceState,
} from "./login-service";

/**
 * Login services as per-user launchd LaunchAgents (macOS).
 *
 * A LaunchAgent in the user's `gui/<uid>` domain, not a boot-time LaunchDaemon:
 * the secrets master key lives in the login keychain, locked until the user
 * logs in, and the runtime is one instance per user anyway. So a service — the
 * gateway, and through its supervisor Postgres, PgBouncer and every backend —
 * starts at login (immediately with auto-login) and is relaunched by launchd if
 * it dies. Both sessions start at login; a `graphical` one is also limited to
 * the Aqua session (`launchd-plist.ts`).
 *
 * launchd runs at most one instance of a label, so a restart through it can
 * never overlap two generations of a service.
 */

const LAUNCHCTL_TIMEOUT_MS = 30_000;
// `launchctl print` of a label the domain does not have.
const LAUNCHCTL_NO_SUCH_SERVICE = 113;

function domain(): string {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("launchd service needs a POSIX uid");
  return `gui/${uid}`;
}

function launchdService(id: LoginServiceId): LoginService {
  const plistPath = () =>
    join(HOME_DIR, "Library", "LaunchAgents", `${id.label}.plist`);
  const target = () => `${domain()}/${id.label}`;

  /** What launchd currently holds for the label. */
  async function state(): Promise<LoginServiceState> {
    const argv = ["launchctl", "print", target()];
    const res = await spawnCaptured(argv, { timeoutMs: LAUNCHCTL_TIMEOUT_MS });
    if (res.exitCode === LAUNCHCTL_NO_SUCH_SERVICE)
      return { kind: "not-loaded" };
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
   * Load the plist into launchd, which starts the job (RunAtLoad) and returns
   * its pid once launchd reports one.
   *
   * Fails loudly when there is no GUI login session for this user (e.g. a bare
   * SSH login on a Mac nobody is logged into): launchctl's own error says so.
   */
  async function load(): Promise<number> {
    await spawnExpectOk(["launchctl", "bootstrap", domain(), plistPath()], {
      timeoutMs: LAUNCHCTL_TIMEOUT_MS,
    });
    let lastExit: string | null = null;
    return retryUntil(
      async () => {
        const s = await state();
        if (s.kind !== "loaded") return null;
        lastExit = s.lastExit;
        return s.pid;
      },
      {
        delay: exponential({ initial: 100, max: 1_000 }),
        deadline: 15_000,
        onDeadline: () => {
          throw new Error(
            `launchd loaded ${id.label} but it is not running (last exit: ${lastExit ?? "none"}); see \`launchctl print ${target()}\``,
          );
        },
      },
    );
  }

  return {
    id,
    manager: "launchd",
    startsAt: "login",
    definitionPath: plistPath,
    state,
    // launchd reads a plist only when it is bootstrapped, so a changed plist
    // takes effect on the next `bootout` + `bootstrap` (or the next login).
    write: (job) =>
      writeDefinition(plistPath(), renderLaunchAgentPlist({ ...id, ...job })),
    remove: async () => removeDefinition(plistPath()),
    load,
    // launchd SIGTERMs it (SIGKILL after the plist's ExitTimeOut). The plist
    // stays, so the next login loads it again.
    unload: async () => {
      await spawnExpectOk(["launchctl", "bootout", target()], {
        timeoutMs: LAUNCHCTL_TIMEOUT_MS,
      });
    },
  };
}

export const launchdManager: LoginServiceManager = {
  manager: "launchd",
  service: launchdService,
};
