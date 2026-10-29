/**
 * Times the shared costs behind the non-check `./equin build` steps, each in a
 * chosen order so the first payer of a process-wide memo is attributed:
 *
 *   ./equin run plugins/framework/plugins/tooling/plugins/codegen/scripts/measure-build-steps.ts \
 *     [--order pipeline|docs-first|guard-first|tree-only|migrations-only] [--json out.json]
 *
 * ONE order per invocation (a fresh process each: the memos make a second order
 * in the same process meaningless). Per step: wall ms (performance.now), CPU ms
 * (process.cpuUsage user+sys), RSS after, ESM/CJS modules newly loaded, fs block
 * reads (process.resourceUsage), plus the step's own counts.
 *
 * Orders:
 *   tree-only        barrel-free faceted tree.
 *   guard-first      tree, web-barrel import (slot declaration), enriched tree
 *                    (server/machine/central barrels + second faceted pass),
 *                    docs render+format (no write).
 *   docs-first       enriched tree cold (it pays tree + web barrels itself),
 *                    then docs render+format.
 *   migrations-only  schema-load probe, then generateMigration.
 *   pipeline         the build's real order: regenerateRegistryCodegen then
 *                    regenerateManifestCodegen, one row per onStep id.
 *
 * Writes: the codegen pipelines and generateMigration write only on a byte
 * difference, so on an in-sync tree nothing changes. Written files are counted
 * by comparing mtimes of every tracked file before and after the run; the files
 * a run touched are listed (and a dirty `git status` is a finding to report).
 */
import { statSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import {
  getWorktreeRoot,
  spawnCaptured,
} from "@plugins/infra/plugins/spawn/core";
import {
  drizzleGenerateArgv,
  MIGRATIONS_PLUGIN_DIR,
  schemaLoadFailures,
  stageDrizzleOut,
} from "@plugins/database/plugins/migrations/core";
import {
  buildBarrelFreeTree,
  buildEnrichedTree,
  declareSlotsFromBarrels,
  formatGenerated,
  regenerateManifestCodegen,
  regenerateRegistryCodegen,
  renderCompactDoc,
  renderDetailsDoc,
  pluginCompactDocPath,
  pluginDetailsDocPath,
} from "../core";

const ORDERS = [
  "pipeline",
  "docs-first",
  "guard-first",
  "tree-only",
  "migrations-only",
] as const;
type Order = (typeof ORDERS)[number];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const orderArg = arg("order") ?? "pipeline";
if (!(ORDERS as readonly string[]).includes(orderArg)) {
  throw new Error(
    `--order must be one of ${ORDERS.join(", ")}, got ${orderArg}`,
  );
}
const order = orderArg as Order;
const jsonOut = arg("json");

interface Row {
  step: string;
  wallMs: number;
  cpuMs: number;
  rssMb: number;
  modulesLoaded: number;
  fsReads: number;
  counts: Record<string, number | string>;
}
const rows: Row[] = [];

// Module registry size. Bun mirrors loaded modules (ESM and CJS) into
// require.cache; verified by the "modules" column moving at all.
const moduleCount = () => Object.keys(require.cache).length;

async function step<T>(
  name: string,
  run: () => Promise<T>,
  counts?: (out: T) => Record<string, number | string>,
): Promise<T> {
  const m0 = moduleCount();
  const c0 = process.cpuUsage();
  const f0 = process.resourceUsage().fsRead;
  const t0 = performance.now();
  const out = await run();
  const wallMs = performance.now() - t0;
  const c = process.cpuUsage(c0);
  rows.push({
    step: name,
    wallMs,
    cpuMs: (c.user + c.system) / 1000,
    rssMb: process.memoryUsage().rss / 1048576,
    modulesLoaded: moduleCount() - m0,
    fsReads: process.resourceUsage().fsRead - f0,
    counts: counts?.(out) ?? {},
  });
  return out;
}

const root = await getWorktreeRoot();

async function trackedMtimes(): Promise<Map<string, number>> {
  const r = await spawnCaptured(["git", "ls-files", "-z"], {
    cwd: root,
    timeoutMs: 120_000,
  });
  const m = new Map<string, number>();
  for (const f of r.stdout.split("\0")) {
    if (!f) continue;
    try {
      m.set(f, statSync(join(root, f)).mtimeMs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      m.set(f, -1);
    }
  }
  return m;
}

const before = await trackedMtimes();
const modulesAtStart = moduleCount();

const barrelCount = async () => {
  const tree = await buildBarrelFreeTree(root);
  const out: Record<string, number> = { plugins: tree.byDir.size };
  for (const rt of ["web", "server", "machine", "central", "core"]) {
    out[`${rt}Barrels`] = [...tree.byDir.values()].filter(
      (n) => Bun.file(join(n.dir, rt, "index.ts")).size > 0,
    ).length;
  }
  return out;
};

async function docsRender() {
  const compact = await formatGenerated({
    file: pluginCompactDocPath(root),
    content: await renderCompactDoc({ root }),
  });
  const details = await formatGenerated({
    file: pluginDetailsDocPath(root),
    content: await renderDetailsDoc({ root }),
  });
  return { compact: compact.length, details: details.length };
}

const treeCounts = async (): Promise<Record<string, number>> => {
  const tree = await buildBarrelFreeTree(root);
  return { plugins: tree.byDir.size };
};

if (order === "tree-only") {
  await step(
    "barrel-free tree",
    () => buildBarrelFreeTree(root),
    (t) => ({
      plugins: t.byDir.size,
    }),
  );
  const last = rows[rows.length - 1]!;
  last.counts = { ...(await barrelCount()) };
}

if (order === "guard-first") {
  await step(
    "barrel-free tree",
    () => buildBarrelFreeTree(root),
    (t) => ({
      plugins: t.byDir.size,
    }),
  );
  await step("web barrels (slot declaration)", () =>
    declareSlotsFromBarrels(root, "registry"),
  );
  await step(
    "enriched tree (server/machine/central + facets)",
    () => buildEnrichedTree(root),
    (t) => ({ plugins: t.byDir.size }),
  );
  await step("docs render+format (no write)", docsRender, (o) => ({
    compactBytes: o.compact,
    detailsBytes: o.details,
  }));
}

if (order === "docs-first") {
  await step(
    "enriched tree cold (tree + web + server barrels)",
    () => buildEnrichedTree(root),
    (t) => ({ plugins: t.byDir.size }),
  );
  await step("docs render+format (no write)", docsRender, (o) => ({
    compactBytes: o.compact,
    detailsBytes: o.details,
  }));
}

if (order === "migrations-only") {
  const failures = await step(
    "schemaLoadFailures (require probe)",
    () => schemaLoadFailures(root),
    (f) => ({ failures: f.length }),
  );
  void failures;
  // generateMigration itself lives in the migrations cli plugin, which a
  // scripts/ folder may not import (and it rewrites data/meta/_journal.json),
  // so its drizzle-kit leg is reproduced from the migrations plugin's core
  // pieces: the same single-tip stage in a temp dir, the same argv, discarded.
  const scaled = (v: number | undefined, unit: number) =>
    v === undefined ? "n/a" : Math.round(v / unit);
  await step(
    "drizzle-kit generate (staged, discarded)",
    async () => {
      const cwd = resolve(root, MIGRATIONS_PLUGIN_DIR);
      const stage = await stageDrizzleOut(cwd, resolve(cwd, "data"));
      try {
        const r = await spawnCaptured(
          drizzleGenerateArgv({
            custom: false,
            name: undefined,
            configPath: stage.configPath,
          }),
          { cwd, timeoutMs: 180_000 },
        );
        return {
          exit: r.exitCode,
          noChange: /No schema changes/i.test(r.stdout + r.stderr),
          // null = the platform reported no rusage for the child (not a zero).
          childCpuMs: scaled(r.resourceUsage.cpuTimeMicros, 1000),
          childRssMb: scaled(r.resourceUsage.maxRssBytes, 1048576),
        };
      } finally {
        stage.dispose();
      }
    },
    (o) => ({ ...o, noChange: String(o.noChange) }),
  );
}

if (order === "pipeline") {
  const record =
    (prefix: string) =>
    async (id: string, label: string, run: () => Promise<void>) => {
      await step(`${prefix}${id} (${label})`, run);
    };
  await step("regenerateRegistryCodegen (total)", async () => {
    await regenerateRegistryCodegen({ root, onStep: record("  reg: ") });
  });
  await step("regenerateManifestCodegen (total)", async () => {
    await regenerateManifestCodegen({ root, onStep: record("  man: ") });
  });
  const t = await treeCounts();
  const first = rows[0]!;
  first.counts = { ...first.counts, ...t };
}

const after = await trackedMtimes();
const touched: string[] = [];
for (const [f, m] of after) if (before.get(f) !== m) touched.push(f);
void resolve;

console.log(
  `order: ${order}   (host load: ${(await import("os"))
    .loadavg()
    .map((x) => x.toFixed(1))
    .join(" ")})`,
);
console.log(
  `${"step".padEnd(62)} ${"wall ms".padStart(8)} ${"cpu ms".padStart(8)} ${"rss MB".padStart(7)} ${"mods".padStart(6)} ${"fsRd".padStart(6)}  counts`,
);
for (const r of rows) {
  console.log(
    `${r.step.padEnd(62)} ${r.wallMs.toFixed(0).padStart(8)} ${r.cpuMs.toFixed(0).padStart(8)} ${r.rssMb.toFixed(0).padStart(7)} ${String(r.modulesLoaded).padStart(6)} ${String(r.fsReads).padStart(6)}  ${JSON.stringify(r.counts)}`,
  );
}
console.log(
  `modules at start ${modulesAtStart}, at end ${moduleCount()}; tracked files written: ${touched.length}${touched.length ? "\n  " + touched.slice(0, 30).join("\n  ") : ""}`,
);

if (jsonOut) {
  writeFileSync(
    jsonOut,
    JSON.stringify(
      {
        order,
        load: (await import("os")).loadavg(),
        rows,
        modulesAtStart,
        modulesAtEnd: moduleCount(),
        filesWritten: touched,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`wrote ${jsonOut}`);
}
