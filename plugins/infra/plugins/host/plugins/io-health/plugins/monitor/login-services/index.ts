// The fs-latency monitor as a per-user login service: `./equin start`
// registers it next to the gateway (ensuring and holding the binary from the
// main checkout), and main's boot moves it onto every new build. Periodic, not
// kept alive: launchd runs one tick every 30 s.
import { HOME_DIR } from "@plugins/infra/plugins/paths/plugins/data-root-layout/core";
import { defineLoginService } from "@plugins/infra/plugins/launcher/plugins/login-services/machine";
import { componentIdentity } from "@plugins/infra/plugins/launcher/plugins/login-services/core";
import { builtFile } from "@plugins/infra/plugins/deps/plugins/build/deps";
import { monitorLogsDir } from "@plugins/debug/data-dirs";
import { MONITOR_INTERVAL_MS } from "@plugins/infra/plugins/host/plugins/io-health/core";
import { fsLatencyMonitorBinary } from "../deps";
import { FS_LATENCY_MONITOR_LABEL } from "../core";

export const fsLatencyMonitorService = defineLoginService({
  id: FS_LATENCY_MONITOR_LABEL,
  owner: "infra/host/io-health/monitor",
  description:
    "equin fs-latency monitor (one tick of host file-I/O health every 30 s)",
  session: "background",
  schedule: { everySeconds: MONITOR_INTERVAL_MS / 1000 },
  // IOKit statistics, vfs.vnstats, darwinbg: there is nothing to read elsewhere.
  platforms: ["darwin"],
  dep: fsLatencyMonitorBinary,
  executable: {
    name: "fs-latency-monitor",
    build: (ready) => ({
      file: builtFile(ready),
      identity: componentIdentity(fsLatencyMonitorBinary.id, ready.identity),
    }),
  },
  spec: (ready, executable) => ({
    argv: [
      executable,
      "--dir",
      monitorLogsDir.ensureSync(),
      // The root daemon of the same label is the one it stands aside for
      // while it writes, and reports while it is installed but silent.
      "--root-label",
      FS_LATENCY_MONITOR_LABEL,
      "--interval-s",
      String(MONITOR_INTERVAL_MS / 1000),
    ],
    cwd: ready.dir,
    env: { HOME: HOME_DIR, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    stdioLog: monitorLogsDir.file("fs-latency-stdio.log"),
    // Its foreground probe is a foreground reading only if launchd lifts the
    // default job type's resource limits.
    interactive: true,
  }),
});

export default [fsLatencyMonitorService];
