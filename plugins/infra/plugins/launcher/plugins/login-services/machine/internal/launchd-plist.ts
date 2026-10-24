import type { LoginServiceSpec } from "../../core";
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
 * - `ExitTimeOut` 20s — the gateway's own shutdown budget is 15s; SIGKILL after
 *   it, not the launchd default, which could cut a backend teardown short.
 *
 * The session is the one varying fact: a `graphical` service carries
 * `LimitLoadToSessionType=Aqua`, so launchd loads it only into a GUI login
 * session. A `background` one renders without the key — byte-identical to the
 * gateway plist from before login services were generic.
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
\t<key>KeepAlive</key>
\t<dict>
\t\t<key>SuccessfulExit</key>
\t\t<false/>
\t</dict>
\t<key>ThrottleInterval</key>
\t<integer>10</integer>
\t<key>ExitTimeOut</key>
\t<integer>20</integer>
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
