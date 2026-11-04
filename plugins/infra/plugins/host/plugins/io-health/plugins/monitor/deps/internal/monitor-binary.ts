import { join, relative, resolve } from "node:path";
import { defineDep } from "@plugins/infra/plugins/deps/deps";
import { build } from "@plugins/infra/plugins/deps/plugins/build/deps";

const PLUGIN = "plugins/infra/plugins/host/plugins/io-health/plugins/monitor";
const BIN = `${PLUGIN}/bin`;
const ENTRY = `${BIN}/fs-latency-monitor.ts`;
const MINUTE = 60_000;

/**
 * Every module the bundle reads, repo-relative — which must all be under
 * `bin/`, the build's declared inputs: a file the identity does not hash would
 * let an edit to it leave the installed binary stale. Type imports are erased,
 * so `WrittenTick` from io-health/core costs nothing here.
 */
async function assertClosedOverBin(root: string): Promise<void> {
  const res = await Bun.build({
    entrypoints: [join(root, ENTRY)],
    target: "bun",
    metafile: true,
  });
  if (!res.success)
    throw new AggregateError(res.logs, `bundling ${ENTRY} failed`);
  // The metafile names inputs relative to this process's cwd.
  const inputs = Object.keys(res.metafile?.inputs ?? {}).map((p) =>
    relative(root, resolve(p)),
  );
  const outside = inputs.filter((p) => !p.startsWith(`${BIN}/`));
  if (outside.length > 0)
    throw new Error(
      `the fs-latency monitor must import nothing outside ${BIN}/ at run time (its build identity hashes only that folder), but it reads ${outside.join(", ")}. Import types only, or pass the value on argv from the login service.`,
    );
}

/**
 * The fs-latency monitor as one standalone executable: `bun build --compile`
 * of `bin/fs-latency-monitor.ts` (≈90 MB — the Bun runtime is inside), so the
 * job launchd runs every 30 s depends on no checkout, no `node_modules` and no
 * backend. macOS only: it reads IOKit, `vfs.vnstats` and darwinbg.
 */
export const fsLatencyMonitorBinary = defineDep({
  id: "fs-latency-monitor",
  owner: "infra/host/io-health/monitor",
  description:
    "The fs-latency monitor: a standalone binary launchd runs every 30 s to measure cold file-metadata latency, cache lifetime, vnode churn, device time per read and system-daemon CPU",
  sizeHint: "≈90 MB",
  source: build({
    inputs: [`${BIN}/**/*.ts`],
    tool: { versionArgv: [process.execPath, "--version"] },
    output: "fs-latency-monitor",
    run: async (ctx) => {
      await assertClosedOverBin(ctx.root);
      await ctx.run(
        [
          process.execPath,
          "build",
          "--compile",
          "--no-compile-autoload-dotenv",
          "--no-compile-autoload-bunfig",
          join(ctx.root, ENTRY),
          "--outfile",
          ctx.output,
        ],
        { cwd: ctx.root, env: { ...process.env }, timeoutMs: 5 * MINUTE },
      );
    },
  }),
  updates: { none: "built from this checkout's own source" },
});
