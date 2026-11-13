import type { PluginLoadReport } from "@plugins/framework/plugins/web-sdk/core";
import { report } from "@plugins/reports/web";
import {
  createLoadProbe,
  describeLoadProbe,
  pageLoadProbeIo,
  type LoadProbe,
} from "./load-probe";

// The specifier the registry's loader imports a plugin by — `import("@plugins/
// <path>/web")` in every generated registry entry.
function webSpecifierOf(pluginPath: string): string {
  return `@plugins/${pluginPath}/web`;
}

function buildReport(info: PluginLoadReport, probe: LoadProbe | Error) {
  const { pluginPath, message } = info;
  const finding =
    probe instanceof Error
      ? `the load probe failed: ${probe.message}`
      : describeLoadProbe(probe);
  return {
    kind: "crash" as const,
    source: "plugin-load" as const,
    message: `${message} — ${finding}`,
    url: window.location.href,
    userAgent: navigator.userAgent,
    // No throw-site stack for a chunk-load failure; the plugin path is the
    // distinguishing info, so encode it into errorType — one crash task per
    // failing plugin (the server fingerprints by errorType + stack).
    data: { errorType: `PluginLoadError ${pluginPath}`, stack: null },
    // The tab's half of the proof that its build was retired; the server
    // re-checks it (reports/core's version-skew). Only a 404 is a proof.
    ...(!(probe instanceof Error) && probe.kind === "missing"
      ? { missingFile: probe.path }
      : {}),
  };
}

// One probe per burst of failures: a retired build fails many plugins over the
// same files, each asked about once. Dropped once the burst settles, so a later
// failure asks the server again — an answer is true only when it was given.
let burst: {
  probe: ReturnType<typeof createLoadProbe>;
  open: number;
} | null = null;

// The handler of web-sdk's `pluginLoadReportSink`, drained through a
// `ReportSinks.Collector` keyed by `framework.web-sdk`. web-sdk is the plugin
// runtime and must not import `reports`, so the loader emits a neutral
// `PluginLoadReport` per failed plugin chunk; this probes why it failed and
// files it as a crash report.
export function collectPluginLoadError(info: PluginLoadReport): void {
  burst ??= { probe: createLoadProbe(pageLoadProbeIo()), open: 0 };
  const current = burst;
  current.open++;
  void current.probe
    .probe(webSpecifierOf(info.pluginPath))
    .catch((err: unknown) =>
      err instanceof Error ? err : new Error(String(err)),
    )
    .then((found) => {
      if (--current.open === 0 && burst === current) burst = null;
      return report(buildReport(info, found));
    });
}
