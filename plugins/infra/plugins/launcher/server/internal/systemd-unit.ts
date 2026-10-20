/**
 * Render a systemd user unit for the gateway — pure, so the exact job the OS
 * will run is unit-testable without systemd. The Linux twin of
 * `launchd-plist.ts`, with the same fixed policy:
 *
 * - `WantedBy=default.target` — started with the user's service manager, which
 *   with lingering enabled is at boot, nobody logged in.
 * - `Restart=on-failure` — relaunch after a crash or a non-zero exit; a clean
 *   stop (exit 0 on SIGTERM) stays stopped (launchd's `SuccessfulExit=false`).
 * - `RestartSec=10` — the gateway exits 1 when Postgres cannot start, and that
 *   must retry, not hot-loop (launchd's `ThrottleInterval`).
 * - `TimeoutStopSec=20` — the gateway's own shutdown budget is 15s (launchd's
 *   `ExitTimeOut`).
 * - `KillMode=process` — a stop signals the gateway ALONE, as launchd does. The
 *   gateway tears its own children (backends, Postgres, PgBouncer) down in
 *   order; and everything a backend spawned lives in this unit's cgroup too —
 *   every running agent process among them, started detached to outlive its
 *   backend — so systemd's default (SIGTERM the whole cgroup, SIGKILL what is
 *   left) would kill every agent on each `start --force`.
 */
export function renderSystemdUserUnit(job: {
  description: string;
  argv: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  /** stdout and stderr both land here (appended). */
  stdioLog: string;
}): string {
  const env = Object.keys(job.env)
    .sort()
    .map((k) => `Environment=${quote(`${k}=${job.env[k]!}`)}`)
    .join("\n");
  return `[Unit]
Description=${specifiers(job.description)}

[Service]
Type=simple
ExecStart=${job.argv.map((a) => quote(a).replaceAll("$", () => "$$")).join(" ")}
WorkingDirectory=${path(job.cwd)}
${env}
Restart=on-failure
RestartSec=10
TimeoutStopSec=20
KillMode=process
StandardOutput=append:${path(job.stdioLog)}
StandardError=append:${path(job.stdioLog)}

[Install]
WantedBy=default.target
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
