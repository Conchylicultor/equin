import { SERVICE_STOP_TIMEOUT_S, type LoginServiceSpec } from "../../core";
import type { InstalledJob } from "./login-service";

/**
 * Render a systemd user unit for a login service — pure, so the exact job the
 * OS will run is unit-testable without systemd. The Linux twin of
 * `launchd-plist.ts`, with the same fixed policy:
 *
 * - `Restart=on-failure` — relaunch after a crash or a non-zero exit; a clean
 *   stop (exit 0 on SIGTERM) stays stopped (launchd's `SuccessfulExit=false`).
 * - `RestartSec=10` — the gateway exits 1 when Postgres cannot start, and that
 *   must retry, not hot-loop (launchd's `ThrottleInterval`).
 * - `TimeoutStopSec` {@link SERVICE_STOP_TIMEOUT_S} — launchd's `ExitTimeOut`;
 *   the gateway's own shutdown is budgeted inside it.
 * - `KillMode=process` — a stop signals the main process ALONE, as launchd
 *   does. The gateway tears its own children (backends, Postgres, PgBouncer)
 *   down in order; and everything a backend spawned lives in this unit's cgroup
 *   too — every running agent process among them, started detached to outlive
 *   its backend — so systemd's default (SIGTERM the whole cgroup, SIGKILL what
 *   is left) would kill every agent on each `start --force`.
 * - `OOMPolicy=continue` — when the kernel OOM-kills ONE process of the unit,
 *   that process alone dies. systemd's default (`stop`) answers any OOM kill
 *   in the unit's cgroup by stopping the whole unit: on an 8 GB Linux host
 *   (2026-11-18) one 2.8 GB check process of main's deploy was killed, and
 *   systemd took the gateway down with it — every backend, Postgres and every
 *   tab — then relaunched it 10 s later (`Result=oom-kill`, measured on
 *   Ubuntu 24.04, systemd 255). Every agent, build and check a backend
 *   spawned lives in this cgroup too, so the default turned any one of them
 *   running out of memory into an outage of the app. A killed process's own
 *   parent reports it (a build's check child dying fails the build, loudly);
 *   the gateway relaunches a backend that died. launchd has no such
 *   whole-job policy: a memory kill there takes one process already.
 *
 * The session decides when it runs:
 * - `background` — `WantedBy=default.target`: started with the user's service
 *   manager, which with lingering enabled is at boot, nobody logged in. Renders
 *   byte-identical to the gateway unit from before login services were generic.
 * - `graphical` — `PartOf=` / `After=` / `WantedBy=graphical-session.target`:
 *   started once the desktop session is up and stopped with it, so it never
 *   runs without a display and needs no lingering.
 */
export function renderSystemdUserUnit(spec: LoginServiceSpec): string {
  // A periodic job is a `.timer` beside a oneshot unit: two files, which this
  // one-file renderer does not write. No Linux service is periodic yet.
  if (spec.schedule !== undefined)
    throw new Error(
      `${spec.label} is periodic; a periodic systemd user service (a .timer unit) is not implemented — declare it for the OSes it runs on (platforms)`,
    );
  const env = Object.keys(spec.env)
    .sort()
    .map((k) => `Environment=${quote(`${k}=${spec.env[k]!}`)}`)
    .join("\n");
  const graphical = spec.session === "graphical";
  const unitDeps = graphical
    ? "PartOf=graphical-session.target\nAfter=graphical-session.target\n"
    : "";
  const wantedBy = graphical ? "graphical-session.target" : "default.target";
  return `[Unit]
Description=${specifiers(spec.description)}
${unitDeps}
[Service]
Type=simple
ExecStart=${spec.argv.map((a) => quote(a).replaceAll("$", () => "$$")).join(" ")}
WorkingDirectory=${path(spec.cwd)}
${env}
Restart=on-failure
RestartSec=10
TimeoutStopSec=${SERVICE_STOP_TIMEOUT_S}
KillMode=process
OOMPolicy=continue
StandardOutput=append:${path(spec.stdioLog)}
StandardError=append:${path(spec.stdioLog)}

[Install]
WantedBy=${wantedBy}
`;
}

/**
 * Read the launch back out of a unit {@link renderSystemdUserUnit} wrote: its
 * `ExecStart` words (each double-quoted, C-escaped, `$$` and `%%` doubled) and
 * `WorkingDirectory`. Null when the file is not one of ours — a hand-edited
 * unit is "unknown", never a guess.
 */
export function parseSystemdUserUnit(unit: string): InstalledJob | null {
  const exec = /^ExecStart=(.*)$/m.exec(unit)?.[1];
  const cwd = /^WorkingDirectory=(.*)$/m.exec(unit)?.[1];
  if (exec === undefined || cwd === undefined) return null;
  const argv: string[] = [];
  const word = /"((?:[^"\\]|\\.)*)"(?: |$)/y;
  while (word.lastIndex < exec.length) {
    const m = word.exec(exec);
    if (m === null) return null;
    argv.push(
      m[1]!
        .replace(/\\(.)/g, "$1")
        .replaceAll("$$", () => "$")
        .replaceAll("%%", "%"),
    );
  }
  return { argv, cwd: cwd.replaceAll("%%", "%") };
}

/** `%` starts a unit specifier everywhere in a unit file. */
function specifiers(v: string): string {
  return v.replaceAll("%", "%%");
}

/**
 * A path setting (`WorkingDirectory=`, `append:`): taken verbatim to the end of
 * the line — systemd does NOT unquote these, so a quoted path reads as relative.
 */
function path(v: string): string {
  if (!v.startsWith("/") || /[\n\r]/.test(v))
    throw new Error(
      `a systemd unit path must be absolute and one line: ${JSON.stringify(v)}`,
    );
  return specifiers(v);
}

/** One double-quoted word, C-escaped, as systemd's unquoting reads it back. */
function quote(v: string): string {
  if (/[\n\r]/.test(v))
    throw new Error(
      `a systemd unit value cannot hold a newline: ${JSON.stringify(v)}`,
    );
  return `"${specifiers(v).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
