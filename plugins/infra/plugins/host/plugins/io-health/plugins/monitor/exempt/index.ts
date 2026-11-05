import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

// The monitor is a standalone binary launchd runs outside the app: it may
// import no repo module at run time (its build fails if it does — the build
// identity hashes only bin/), so the app's own wrappers are out of reach.
const STANDALONE =
  "A standalone program compiled from bin/ alone (deps/ refuses a bundle reaching outside it): the repo wrapper this rule asks for is a runtime import it cannot have.";

export default [
  {
    rule: "timed-fs/no-untimed-fs-read",
    paths: ["bin/fs-latency-monitor.ts", "bin/rotate.ts", "bin/root-daemon.ts"],
    kind: "sanctioned",
    reason: `${STANDALONE} And its probes time their own reads — that IS the measurement; there is no span to attribute a stall to.`,
  },
  {
    rule: "owned-fd/no-raw-fd-close",
    paths: ["bin/fs-latency-monitor.ts", "bin/native.ts"],
    kind: "sanctioned",
    reason: `${STANDALONE} Each descriptor is opened and closed in one try/finally of a single-threaded run-and-exit process with no pool to reuse the number.`,
  },
  {
    rule: "sink-safety/no-adhoc-file-sink",
    paths: ["bin/fs-latency-monitor.ts"],
    kind: "sanctioned",
    reason: `${STANDALONE} The append is bounded: bin/rotate.ts moves everything past the trailing two hours into gzip archives once the log passes 4 MB, before every append.`,
  },
] satisfies Exemptions;
