// The demo's starting snapshot, taken ONCE per snapshot address by the build
// (web-artifacts' host-snapshot stage runs this file with `<out>` and the
// initialized PGlite cluster its database opens from, `<cluster>`, in a fresh
// process): the worker's own graph booted in Bun (`./bun-host.ts`), filled by
// the real seed (`./seed.ts` — the apps' write paths, the page tools, the
// transcript built from their results), settled, then its whole state written
// to `<out>` (host-storage's `takeHostSnapshot`). The worker loads it on a
// fresh storage instead of seeding (`./browser-host.ts`), so no seed code runs
// in a visitor's browser.
import "./declare-namespace"; // MUST stay first: see the file.
import { writeFileSync } from "node:fs";
import { readFileSync } from "@plugins/packages/plugins/timed-fs/core";
import {
  decodeHostSnapshot,
  takeHostSnapshot,
} from "@plugins/framework/plugins/browser-server/plugins/host-storage/core";
import { bootBrowserHost } from "@plugins/framework/plugins/server-core/core";
import { unmatchedApiResponse } from "@plugins/infra/plugins/endpoints/core";
import { readDarwinBackground } from "@plugins/packages/plugins/spawn-priority/core";
import { bunHostEntries, diskDemoData, diskMigrationHashes } from "./bun-host";
import { seed } from "./seed";

const [out, cluster] = process.argv.slice(2);
if (out === undefined || cluster === undefined) {
  throw new Error("usage: browser-host.snapshot.ts <out-file> <cluster-file>");
}
const file = await takeHostSnapshot({
  migrations: diskMigrationHashes(),
  cluster: new Blob([readFileSync(cluster)]),
  boot: async () => {
    const host = await bootBrowserHost({
      entries: bunHostEntries(),
      seed: (h) => seed(diskDemoData(), h),
      onUnmatched: unmatchedApiResponse,
    });
    // What the take cost, split: the build log carries it for every take.
    // With the scheduling tier it ran in: darwinbg (an agent's shell) runs on
    // the efficiency cores and reads 3-4x slower than the build's foreground.
    const { stages, slowest } = host.boot;
    console.info(
      `[workspace demo snapshot] boot (${readDarwinBackground().kind}): ${stages.map((s) => `${s.name} ${s.ms} ms`).join(", ")}; slowest: ${slowest.map((s) => `${s.label} ${s.ms} ms`).join(", ")}`,
    );
    return host;
  },
});
writeFileSync(out, file);
// What each host store ships with (the transcripts, the config, the saved
// icons the warm-ups drew…): a store missing here is one a first visit fills
// in the visitor's browser instead.
const stores = Object.entries(decodeHostSnapshot(file).stores)
  .map(([name, entries]) => `${name} ${entries.length}`)
  .join(", ");
console.info(
  `[workspace demo snapshot] wrote ${out} (${(file.byteLength / 1024).toFixed(0)} KB; stores: ${stores})`,
);
// The booted host's watchers and job timers keep the event loop alive: this
// process exists to write the file, and is done.
process.exit(0);
