import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { spawnExpectOk } from "@plugins/infra/plugins/spawn/core";
import { HOME_DIR } from "@plugins/infra/plugins/paths/core";
import { retryUntil, exponential } from "@plugins/packages/plugins/retry/core";
import type { LoginServiceId } from "../../core";
import {
  isDefinitionCurrent,
  readDefinition,
  removeDefinition,
  writeDefinition,
} from "./definition-file";
import { bindInstalledLabel } from "./installed-label";
import { parseSystemdUserUnit, renderSystemdUserUnit } from "./systemd-unit";
import type {
  LoginService,
  LoginServiceManager,
  LoginServiceState,
} from "./login-service";

/**
 * Login services as systemd USER units (Linux) — the twin of the launchd
 * LaunchAgents, in the user's own service manager (`systemctl --user`), never
 * system units: the runtime is one instance per user and initdb refuses root.
 *
 * A `background` service (the gateway) starts at BOOT, not at login, because it
 * requires lingering (`loginctl enable-linger`): without it the user's manager
 * — and with it the gateway and every backend and agent — is stopped when the
 * last session of the user closes, so a gateway started over ssh would die
 * with the ssh session. `load` refuses without it rather than start a service
 * that quietly will not outlive the shell. Nothing here is locked until a
 * login, as the macOS login keychain is: the secrets master key is a file on
 * Linux (`infra/secrets`).
 *
 * A `graphical` service belongs to the desktop session
 * (`graphical-session.target`): it starts at login and stops with the session,
 * so it needs no lingering.
 */

const SYSTEMCTL_TIMEOUT_MS = 30_000;

function systemctl(...args: string[]): string[] {
  return ["systemctl", "--user", ...args];
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

/** Where the user unit of `label` lives. */
function systemdUnitPath(label: string): string {
  const configHome = process.env.XDG_CONFIG_HOME || join(HOME_DIR, ".config");
  return join(configHome, "systemd", "user", `${label}.service`);
}

function systemdService(id: LoginServiceId): LoginService {
  const unit = `${id.label}.service`;
  const unitPath = () => systemdUnitPath(id.label);

  async function unitProps(): Promise<Record<string, string>> {
    const res = await spawnExpectOk(
      systemctl(
        "show",
        unit,
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

  async function state(): Promise<LoginServiceState> {
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

  async function load(): Promise<number> {
    if (id.session === "background") await assertLingering();
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
        `systemd cannot load ${unitPath()} (LoadState=${LoadState ?? "unknown"}); see \`journalctl --user -u ${unit}\``,
      );
    }
    await spawnExpectOk(systemctl("enable", "--now", unit), {
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
            `systemd started ${unit} but it is not running (last exit status: ${lastExit ?? "none"}); see \`systemctl --user status ${unit}\``,
          );
        },
      },
    );
  }

  async function remove(): Promise<boolean> {
    const path = unitPath();
    if (!existsSync(path)) return false;
    // `disable` removes the `<target>.wants` link; it must run while the unit
    // file still exists.
    await spawnExpectOk(systemctl("disable", unit), {
      timeoutMs: SYSTEMCTL_TIMEOUT_MS,
    });
    removeDefinition(path);
    await spawnExpectOk(systemctl("daemon-reload"), {
      timeoutMs: SYSTEMCTL_TIMEOUT_MS,
    });
    return true;
  }

  return {
    id,
    manager: "systemd",
    startsAt: id.session === "background" ? "boot" : "login",
    definitionPath: unitPath,
    state,
    write: (job) =>
      writeDefinition(unitPath(), renderSystemdUserUnit({ ...id, ...job })),
    isCurrent: (job) =>
      isDefinitionCurrent(unitPath(), renderSystemdUserUnit({ ...id, ...job })),
    installedJob: () => {
      const content = readDefinition(unitPath());
      return content === null ? null : parseSystemdUserUnit(content);
    },
    remove,
    load,
    unload: async () => {
      await spawnExpectOk(systemctl("stop", unit), {
        timeoutMs: SYSTEMCTL_TIMEOUT_MS,
      });
    },
  };
}

export const systemdManager: LoginServiceManager = {
  manager: "systemd",
  service: (id) => systemdService(bindInstalledLabel(id, systemdUnitPath)),
};
