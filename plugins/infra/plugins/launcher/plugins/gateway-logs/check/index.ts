import { readFile } from "@plugins/packages/plugins/timed-fs/core";
import { join } from "node:path";
import type { Check } from "@plugins/framework/plugins/tooling/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
// Own plugin, so relative.
import {
  DEPLOY_LOGS_SUBDIR,
  GATEWAY_LOG_BOUND,
  SERVICE_LOGS_SUBDIR,
} from "../data-dirs";
import { SERVICE_LOG_FD_FLAG } from "../core";

/**
 * The gateway (Go) writes its log channels and hands each supervised service
 * its log fd; TypeScript names the same files (`PG_LOG_FILE`, Debug → Logs),
 * shows their bound, and parses the fd off the start command's argv. Go cannot
 * import the TypeScript constants, so each pair is pinned here. A drift is
 * silent: the readers would point at a file nobody writes, or the start scripts
 * would see no relay and fall back to their pre-relay behaviour.
 */
const PINS: ReadonlyArray<{
  file: string;
  goName: string;
  re: RegExp;
  read: (m: RegExpExecArray) => string;
  ts: string;
  tsName: string;
}> = [
  {
    file: "gateway/logrelay.go",
    goName: "serviceLogsSubdir",
    re: /\bserviceLogsSubdir\s*=\s*"([^"]+)"/,
    read: (m) => m[1]!,
    ts: SERVICE_LOGS_SUBDIR,
    tsName: "SERVICE_LOGS_SUBDIR (launcher/gateway-logs data-dirs)",
  },
  {
    file: "gateway/main_deploy.go",
    goName: "deployLogsSubdir",
    re: /\bdeployLogsSubdir\s*=\s*"([^"]+)"/,
    read: (m) => m[1]!,
    ts: DEPLOY_LOGS_SUBDIR,
    tsName: "DEPLOY_LOGS_SUBDIR (launcher/gateway-logs data-dirs)",
  },
  {
    file: "gateway/logrelay.go",
    goName: "serviceLogFdFlag",
    re: /\bserviceLogFdFlag\s*=\s*"([^"]+)"/,
    read: (m) => m[1]!,
    ts: SERVICE_LOG_FD_FLAG,
    tsName: "SERVICE_LOG_FD_FLAG (launcher/gateway-logs core)",
  },
  {
    file: "gateway/logwriter.go",
    goName: "maxLogBytes",
    re: /\bmaxLogBytes\s+int64\s*=\s*([0-9 *]+)\n/,
    read: (m) =>
      String(
        m[1]!
          .split("*")
          .map((f) => Number(f.trim()))
          .reduce((a, b) => a * b, 1),
      ),
    ts: String(GATEWAY_LOG_BOUND.maxBytes),
    tsName: "GATEWAY_LOG_BOUND.maxBytes (launcher/gateway-logs data-dirs)",
  },
  {
    file: "gateway/logwriter.go",
    goName: "maxLogBackups",
    re: /\bmaxLogBackups\s*=\s*([0-9]+)/,
    read: (m) => m[1]!,
    ts: String(GATEWAY_LOG_BOUND.keep),
    tsName: "GATEWAY_LOG_BOUND.keep (launcher/gateway-logs data-dirs)",
  },
];

const serviceLogsInSyncCheck: Check = {
  id: "gateway-logs:in-sync",
  description:
    "The gateway's service-log constants (serviceLogsSubdir, serviceLogFdFlag in gateway/logrelay.go; deployLogsSubdir in gateway/main_deploy.go; maxLogBytes, maxLogBackups in gateway/logwriter.go) equal their TypeScript twins (SERVICE_LOGS_SUBDIR, SERVICE_LOG_FD_FLAG, DEPLOY_LOGS_SUBDIR, GATEWAY_LOG_BOUND)",
  async run() {
    const root = await getWorktreeRoot();
    const problems: string[] = [];
    for (const pin of PINS) {
      const text = await readFile(join(root, pin.file), "utf8");
      const m = pin.re.exec(text);
      if (!m) {
        problems.push(`${pin.file} declares no ${pin.goName} constant`);
        continue;
      }
      const go = pin.read(m);
      if (go !== pin.ts) {
        problems.push(
          `${pin.file} ${pin.goName} = ${go}, but ${pin.tsName} = ${pin.ts}`,
        );
      }
    }
    if (problems.length === 0) return { ok: true };
    return {
      ok: false,
      message: problems.join("\n"),
      hint: "Change both sides together: the Go constant and its TypeScript twin name the same file, flag or bound.",
    };
  },
};

export default [serviceLogsInSyncCheck];
