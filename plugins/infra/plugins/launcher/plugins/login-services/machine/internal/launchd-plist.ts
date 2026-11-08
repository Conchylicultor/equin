import { SERVICE_STOP_TIMEOUT_S, type LoginServiceSpec } from "../../core";
import type { InstalledJob } from "./login-service";

/**
 * Render a launchd property list for a per-user LaunchAgent — pure, so the exact
 * job the OS will run is unit-testable without launchd.
 *
 * The policy is fixed here rather than taken as options: it is the policy every
 * login service shares, set by the most demanding one (the gateway):
 * - `RunAtLoad` — start when loaded, i.e. at login and on `launchctl bootstrap`.
 * - `KeepAlive.SuccessfulExit = false` — relaunch after a crash or a non-zero
 *   exit; a clean stop (exit 0 on SIGTERM) stays stopped.
 * - `ThrottleInterval` 10s — the gateway exits 1 when Postgres cannot start, and
 *   that must retry, not hot-loop.
 * - `ExitTimeOut` {@link SERVICE_STOP_TIMEOUT_S} — SIGKILL after it, not the
 *   launchd default; the gateway's own shutdown is budgeted inside it.
 *
 * The session is the one varying fact: a `graphical` service carries
 * `LimitLoadToSessionType=Aqua`, so launchd loads it only into a GUI login
 * session. A `background` one renders without the key — byte-identical to the
 * gateway plist from before login services were generic.
 *
 * A periodic service (`schedule`) runs at load and then every
 * `StartInterval` seconds instead: no `KeepAlive` (each run exits on its own;
 * a failed run is simply followed by the next one) and so no
 * `ThrottleInterval`. launchd never starts a run while the previous one is
 * still going. `interactive` adds `ProcessType Interactive`: launchd's
 * default type carries resource limits a measurement must not read as the
 * machine's.
 */
export function renderLaunchAgentPlist(spec: LoginServiceSpec): string {
  const str = (v: string) => `<string>${escapeXml(v)}</string>`;
  const envEntries = Object.keys(spec.env)
    .sort()
    .map((k) => `\t\t<key>${escapeXml(k)}</key>\n\t\t${str(spec.env[k]!)}`)
    .join("\n");
  const session =
    spec.session === "graphical"
      ? `\t<key>LimitLoadToSessionType</key>\n\t${str("Aqua")}\n`
      : "";
  const runs =
    spec.schedule === undefined
      ? `\t<key>KeepAlive</key>\n\t<dict>\n\t\t<key>SuccessfulExit</key>\n\t\t<false/>\n\t</dict>\n\t<key>ThrottleInterval</key>\n\t<integer>10</integer>\n`
      : `\t<key>StartInterval</key>\n\t<integer>${interval(spec.schedule.everySeconds)}</integer>\n`;
  const processType = spec.interactive
    ? `\t<key>ProcessType</key>\n\t${str("Interactive")}\n`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t${str(spec.label)}
${session}\t<key>ProgramArguments</key>
\t<array>
${spec.argv.map((a) => `\t\t${str(a)}`).join("\n")}
\t</array>
\t<key>WorkingDirectory</key>
\t${str(spec.cwd)}
\t<key>EnvironmentVariables</key>
\t<dict>
${envEntries}
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
${runs}${processType}\t<key>ExitTimeOut</key>
\t<integer>${SERVICE_STOP_TIMEOUT_S}</integer>
\t<key>StandardOutPath</key>
\t${str(spec.stdioLog)}
\t<key>StandardErrorPath</key>
\t${str(spec.stdioLog)}
</dict>
</plist>
`;
}

/**
 * Read the launch back out of a plist {@link renderLaunchAgentPlist} wrote: its
 * `ProgramArguments` and `WorkingDirectory`. Null when the file is not one of
 * ours (no such keys) — a hand-edited plist is "unknown", never a guess.
 */
export function parseLaunchAgentPlist(xml: string): InstalledJob | null {
  const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(
    xml,
  );
  const cwd = /<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/.exec(
    xml,
  );
  if (args === null || cwd === null) return null;
  const argv = [...args[1]!.matchAll(/<string>([^<]*)<\/string>/g)].map((m) =>
    unescapeXml(m[1]!),
  );
  return { argv, cwd: unescapeXml(cwd[1]!) };
}

function interval(seconds: number): number {
  if (!Number.isInteger(seconds) || seconds < 1)
    throw new Error(
      `a launchd StartInterval is a whole number of seconds ≥ 1, not ${seconds}`,
    );
  return seconds;
}

function unescapeXml(v: string): string {
  return v
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function escapeXml(v: string): string {
  return v
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
