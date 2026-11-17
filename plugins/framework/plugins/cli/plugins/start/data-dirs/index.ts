import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * Where `./equin start` writes the step-by-step lines of the modules it drives
 * (the dependency installs, the app bundle, each login service's reconcile,
 * the gateway build and launch). Those lines name internal parts and paths, so
 * they never go to the terminal a person installing reads (the installer
 * message rules, `infra/launcher/installer-notice`) — they land here, and the
 * terminal names this file on a `details:` line.
 */
export const startLogs = defineDataDir({
  kind: "logs",
  name: "start",
  owner: "framework/cli/start",
  description:
    "`./equin start`'s detailed progress: what each step it drives installed, kept, removed or bound — the last run only",
  // Observability output: the record of the last start, never anything the
  // running system reads.
  reclaim: { kind: "safe" },
  // A file sink (2 MB, one rotation), emptied by every run as well, so it
  // holds the last run's lines.
  logs: [{ pattern: "start.log", bound: { kind: "file-sink" } }],
});

export default [startLogs];
