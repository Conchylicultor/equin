import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { spawnExpectOk } from "@plugins/infra/plugins/spawn/core";
import { HOME_DIR } from "@plugins/infra/plugins/paths/core";
import { retryUntil, exponential } from "@plugins/packages/plugins/retry/core";
import { renderSystemdUserUnit } from "./systemd-unit";
import type { gatewayLaunchSpec } from "./boot";
import {
  GATEWAY_SERVICE_LABEL,
  type GatewayLoginService,
  type GatewayServiceState,
} from "./gateway-service";

/**
 * The gateway as a systemd USER unit (Linux) — the twin of the launchd
 * LaunchAgent, in the user's own service manager (`systemctl --user`), never a
 * system unit: the runtime is one instance per user and initdb refuses root.
 *
 * It starts at BOOT, not at login, because it requires lingering
 * (`loginctl enable-linger`): without it the user's manager — and with it the
 * gateway and every backend and agent — is stopped when the last session of the
 * user closes, so a gateway started over ssh would die with the ssh session.
 * `load` refuses without it rather than start a gateway that quietly will not
 * outlive the shell. Nothing here is locked until a login, as the macOS login
 * keychain is: the secrets master key is a file on Linux (`infra/secrets`).
 */

const UNIT = `${GATEWAY_SERVICE_LABEL}.service`;
const SYSTEMCTL_TIMEOUT_MS = 30_000;

function unitPath(): string {
  const configHome = process.env.XDG_CONFIG_HOME || join(HOME_DIR, ".config");
  return join(configHome, "systemd", "user", UNIT);
}

function systemctl(...args: string[]): string[] {
  return ["systemctl", "--user", ...args];
}

async function unitProps(): Promise<Record<string, string>> {
  const res = await spawnExpectOk(
    systemctl(
      "show",
      UNIT,
      "-p",
      "LoadState",
      "-p",
      "ActiveState",
      "-p",
      "MainPID",
      "-p",
      "ExecMainStatus",
    ),
    { timeoutMs: SYSTEMCTL_TIMEOUT_MS },
  );
  return Object.fromEntries(
    res.stdout
      .split("\n")
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
}

async function state(): Promise<GatewayServiceState> {
  const props = await unitProps();
  // launchd's "not bootstrapped": systemd knows no such unit, or holds it but
  // is not running nor about to relaunch it (stopped, or given up on).
  if (
    props.LoadState !== "loaded" ||
    props.ActiveState === "inactive" ||
    props.ActiveState === "failed"
  ) {
    return { kind: "not-loaded" };
  }
  const pid = Number(props.MainPID ?? "0");
  return {
    kind: "loaded",
    // 0 while `activating (auto-restart)` between relaunches.
    pid: pid > 0 ? pid : null,
    lastExit: props.ExecMainStatus ?? null,
  };
}

function write(spec: ReturnType<typeof gatewayLaunchSpec>): {
  path: string;
  changed: boolean;
} {
  const path = unitPath();
  const content = renderSystemdUserUnit({
    description:
      "Singularity gateway (and through it Postgres, PgBouncer and every backend)",
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

async function assertLingering(): Promise<void> {
  const user = userInfo().username;
  const res = await spawnExpectOk(
    ["loginctl", "show-user", user, "-p", "Linger", "--value"],
    { timeoutMs: SYSTEMCTL_TIMEOUT_MS },
  );
  if (res.stdout.trim() !== "yes") {
    throw new Error(
      `lingering is off for ${user}: systemd would stop the gateway (and every agent) when your last session closes, and not start it at boot. Enable it once, as root: sudo loginctl enable-linger ${user}`,
    );
  }
}

async function load(): Promise<number> {
  await assertLingering();
  // systemd reads a unit file only on daemon-reload.
  await spawnExpectOk(systemctl("daemon-reload"), {
    timeoutMs: SYSTEMCTL_TIMEOUT_MS,
  });
  // A unit file systemd refused to parse is not an error to `enable --now`:
  // nothing would ever start, so say so now rather than as a "not running
  // yet" deadline.
  const { LoadState } = await unitProps();
  if (LoadState !== "loaded") {
    throw new Error(
      `systemd cannot load ${unitPath()} (LoadState=${LoadState ?? "unknown"}); see \`journalctl --user -u ${UNIT}\``,
    );
  }
  await spawnExpectOk(systemctl("enable", "--now", UNIT), {
    timeoutMs: SYSTEMCTL_TIMEOUT_MS,
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
          `systemd started ${UNIT} but it is not running (last exit status: ${lastExit ?? "none"}); see \`systemctl --user status ${UNIT}\``,
        );
      },
    },
  );
}

async function unload(): Promise<void> {
  await spawnExpectOk(systemctl("stop", UNIT), {
    timeoutMs: SYSTEMCTL_TIMEOUT_MS,
  });
}

async function remove(): Promise<boolean> {
  const path = unitPath();
  if (!existsSync(path)) return false;
  // `disable` removes the default.target.wants link; it must run while the
  // unit file still exists.
  await spawnExpectOk(systemctl("disable", UNIT), {
    timeoutMs: SYSTEMCTL_TIMEOUT_MS,
  });
  rmSync(path);
  await spawnExpectOk(systemctl("daemon-reload"), {
    timeoutMs: SYSTEMCTL_TIMEOUT_MS,
  });
  return true;
}

export const systemdGatewayService: GatewayLoginService = {
  manager: "systemd",
  startsAt: "boot",
  definitionPath: unitPath,
  state,
  write,
  remove,
  load,
  unload,
};
