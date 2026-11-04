/**
 * Print the plist of the monitor's ROOT LaunchDaemon — the opt-in that adds
 * attribution (top disk readers per process, fseventsd's open log files, an
 * `fs_usage` capture on a stall). It runs the same binary the login service
 * installed into the equin app, so it follows main's builds by itself; while it
 * is installed, the user agent stands aside (`--defer-to`). Install it, as
 * root, with:
 *
 *   ./equin run plugins/infra/plugins/host/plugins/io-health/plugins/monitor/scripts/root-daemon-plist.ts \
 *     | sudo tee /Library/LaunchDaemons/dev.equin.fs-latency-monitor.plist >/dev/null
 *   sudo chown root:wheel /Library/LaunchDaemons/dev.equin.fs-latency-monitor.plist
 *   sudo launchctl bootstrap system /Library/LaunchDaemons/dev.equin.fs-latency-monitor.plist
 *
 * (the monitor's CLAUDE.md has the way back).
 */
import { existsSync } from "@plugins/packages/plugins/timed-fs/core";
import { monitorLogsDir } from "@plugins/debug/data-dirs";
import { macosAppDir } from "@plugins/infra/plugins/launcher/plugins/login-services/data-dirs";
import { MONITOR_INTERVAL_MS } from "@plugins/infra/plugins/host/plugins/io-health/core";
import { FS_LATENCY_MONITOR_LABEL } from "../core";

// The login service's executable inside the equin app (login-services' bundle layout).
const executable = macosAppDir.file(
  "equin.app",
  "Contents",
  "MacOS",
  "fs-latency-monitor",
);
if (!existsSync(executable))
  throw new Error(
    `${executable} is not installed: run \`./equin start --only ${FS_LATENCY_MONITOR_LABEL}\` first — the root daemon runs the binary the login service installs`,
  );

const esc = (v: string) =>
  v.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const stdio = esc(monitorLogsDir.file("fs-latency-root-stdio.log"));

process.stdout.write(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${FS_LATENCY_MONITOR_LABEL}</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>${esc(executable)}</string>
\t\t<string>--dir</string>
\t\t<string>${esc(monitorLogsDir.path)}</string>
\t</array>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>StartInterval</key>
\t<integer>${MONITOR_INTERVAL_MS / 1000}</integer>
\t<key>ProcessType</key>
\t<string>Interactive</string>
\t<key>StandardOutPath</key>
\t<string>${stdio}</string>
\t<key>StandardErrorPath</key>
\t<string>${stdio}</string>
</dict>
</plist>
`);
