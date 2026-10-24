import type { LoginServiceSpec } from "../../core";

/**
 * Render a systemd user unit for a login service — pure, so the exact job the
 * OS will run is unit-testable without systemd. The Linux twin of
 * `launchd-plist.ts`, with the same fixed policy:
 *
 * - `Restart=on-failure` — relaunch after a crash or a non-zero exit; a clean
 *   stop (exit 0 on SIGTERM) stays stopped (launchd's `SuccessfulExit=false`).
 * - `RestartSec=10` — the gateway exits 1 when Postgres cannot start, and that
 *   must retry, not hot-loop (launchd's `ThrottleInterval`).
 * - `TimeoutStopSec=20` — the gateway's own shutdown budget is 15s (launchd's
 *   `ExitTimeOut`).
 * - `KillMode=process` — a stop signals the main process ALONE, as launchd
 *   does. The gateway tears its own children (backends, Postgres, PgBouncer)
 *   down in order; and everything a backend spawned lives in this unit's cgroup
 *   too — every running agent process among them, started detached to outlive
 *   its backend — so systemd's default (SIGTERM the whole cgroup, SIGKILL what
 *   is left) would kill every agent on each `start --force`.
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
TimeoutStopSec=20
KillMode=process
StandardOutput=append:${path(spec.stdioLog)}
StandardError=append:${path(spec.stdioLog)}

[Install]
WantedBy=${wantedBy}
`;
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
