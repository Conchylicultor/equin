import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";
import { readEnv } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { GATEWAY_SERVICE } from "@plugins/infra/plugins/launcher/core";
import { loginServiceManager } from "@plugins/infra/plugins/launcher/plugins/login-services/machine";
import {
  backupsDirs,
  CLAUDE_PROJECTS_DIR,
  DataRootSplitError,
  HOME_DIR,
  readHomeDataRootLayout,
  type DataRootLayout,
} from "@plugins/infra/plugins/paths/core";
import { listActiveWorktreeOps } from "@plugins/infra/plugins/worktree/server";
import {
  pidAlive,
  readPidFile,
} from "@plugins/infra/plugins/spawn/plugins/daemon/server";
import {
  getWorktreeRoot,
  spawnPassthrough,
} from "@plugins/infra/plugins/spawn/core";
import { sdkAgentPidsDir } from "@plugins/conversations/plugins/runtime-sdk/data-dirs";
import { pgPostmasterPidFile } from "@plugins/database/plugins/embedded/server";
import { pgbouncerPidFileUnder } from "@plugins/database/plugins/pgbouncer/server";
import {
  DATABASE_CONFIG_PATH,
  type DatabaseConfig,
} from "@plugins/database/core";
import { CLI_NAME } from "@plugins/framework/plugins/cli/plugins/cli-name/core";
import {
  describePlan,
  planRootMigration,
  type LiveAgent,
  type LiveWork,
  type MigrationFacts,
  type MigrationPlan,
  type Move,
} from "./plan";
import {
  listDatabases,
  rewriteDatabase,
  scanDatabase,
  type DbLeftover,
} from "./databases";
import { visitFiles } from "./files";
import { moveClaudeProjects } from "./claude-projects";
import { rewriteDbValue } from "./rewrite";

// `./equin data-dir migrate`: the effects of the plan `./plan.ts` decides.
// Design: research/2026-10-26-global-equin-data-dir-migration-v2.md

type Opts = { apply?: boolean; stopAgents?: boolean };

const run: CliAction<[], Opts> = async (opts) => {
  const facts = await gatherFacts(opts.stopAgents === true);
  const plan = planRootMigration(facts);
  console.log(describePlan(plan));
  if (plan.kind === "refuse") process.exit(1);
  if (plan.kind === "done") return;
  if (!opts.apply) {
    console.log(
      `\nDry run: nothing changed. Run \`./${CLI_NAME} data-dir migrate --apply\` to execute it.`,
    );
    return;
  }
  await apply(plan, facts);
};
export default run;

// ─── facts ──────────────────────────────────────────────────────────────────

function readLayout(): MigrationFacts["layout"] {
  const dir = readEnv("DIR");
  if (dir !== undefined) return { kind: "custom", root: dir };
  try {
    return readHomeDataRootLayout(HOME_DIR);
  } catch (err) {
    if (err instanceof DataRootSplitError) {
      return { kind: "split", message: err.message };
    }
    throw err;
  }
}

function rootOf(layout: MigrationFacts["layout"]): string | null {
  return layout.kind === "split" ? null : layout.root;
}

/** Whether `path` sits inside `root` (both resolved; `root` itself counts). */
function inside(path: string, root: string): boolean {
  if (!existsSync(root)) return false;
  const r = realpathSync(root);
  const p = realpathSync(path);
  return p === r || p.startsWith(`${r}/`);
}

/** Every SDK agent process alive on the machine, any namespace, by its pid file. */
function liveAgents(): LiveAgent[] {
  const root = sdkAgentPidsDir.path;
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((namespace) => {
    const dir = join(root, namespace);
    if (!lstatSync(dir).isDirectory()) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith(".pid"))
      .flatMap((name) => {
        const read = readPidFile(join(dir, name));
        return read.kind === "pid" && pidAlive(read.pid)
          ? [
              {
                what: `agent ${name.slice(0, -".pid".length)} of ${namespace} (pid ${read.pid})`,
                pid: read.pid,
              },
            ]
          : [];
      });
  });
}

async function liveOps(): Promise<LiveWork[]> {
  return (await listActiveWorktreeOps()).map((op) => ({
    what: `${op.op} in ${op.slug} (pid ${op.pid})`,
  }));
}

async function gatherFacts(stopAgents: boolean): Promise<MigrationFacts> {
  const layout = readLayout();
  const root = rootOf(layout);
  const backups = backupsDirs();
  const legacyBackups = existsSync(backups.legacy)
    ? lstatSync(backups.legacy)
    : null;
  const manager = loginServiceManager();
  return {
    layout,
    backups: {
      ...backups,
      legacyExists: legacyBackups !== null && !legacyBackups.isSymbolicLink(),
      legacyIsLink: legacyBackups?.isSymbolicLink() ?? false,
      currentExists: existsSync(backups.current),
    },
    oldLabelInstalled:
      manager?.service(GATEWAY_SERVICE).id.label === LEGACY_IDS.launchdLabel,
    runByAgent: readEnv("CONVERSATION_ID") !== undefined,
    cwdInsideRoot:
      root !== null && inside(process.cwd(), root) ? process.cwd() : null,
    // Only the home layouts move anything; a refused plan needs no scan.
    ...(layout.kind === "legacy" || layout.kind === "current"
      ? { liveWork: await liveOps(), liveAgents: liveAgents() }
      : { liveWork: [], liveAgents: [] }),
    stopAgents,
  };
}

// ─── apply ──────────────────────────────────────────────────────────────────

type MigratePlan = Extract<MigrationPlan, { kind: "migrate" }>;

function step(text: string): void {
  console.log(`\n==> ${text}`);
}

/** Run this checkout's own CLI verb, its output on this terminal; throws when it fails. */
async function equin(checkout: string, ...args: string[]): Promise<void> {
  const res = await spawnPassthrough([join(checkout, CLI_NAME), ...args], {
    cwd: checkout,
  });
  if (res.exitCode !== 0) {
    throw new Error(`./${CLI_NAME} ${args.join(" ")} exited ${res.exitCode}`);
  }
}

/** Signal the process a pid file names and wait for it to be gone (up to `ms`). */
async function stopByPidFile(
  what: string,
  pidFile: string,
  signal: NodeJS.Signals,
  ms: number,
): Promise<void> {
  const read = readPidFile(pidFile);
  if (read.kind !== "pid") return;
  await stopByPid(`${what} (pid ${read.pid})`, read.pid, signal, ms);
}

/** Signal `pid` and wait for it to be gone (up to `ms`); throws, having moved nothing, when it stays. */
async function stopByPid(
  what: string,
  pid: number,
  signal: NodeJS.Signals,
  ms: number,
): Promise<void> {
  if (!pidAlive(pid)) return;
  console.log(`Stopping ${what} (${signal})…`);
  try {
    process.kill(pid, signal);
  } catch (err) {
    // Exited between the liveness check and the signal.
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
  const deadline = Date.now() + ms;
  while (pidAlive(pid)) {
    if (Date.now() > deadline) {
      throw new Error(
        `${what} is still running ${ms / 1000}s after ${signal}; nothing was moved. Stop it, then rerun.`,
      );
    }
    await Bun.sleep(200);
  }
}

/** Move `from` to `to`, leaving `from` a relative link to it (the safety net while the rewrite runs). */
function moveAndLink(move: Move): void {
  renameSync(move.from, move.to);
  try {
    symlinkSync(relative(dirname(move.from), move.to), move.from);
  } catch (err) {
    renameSync(move.to, move.from);
    throw err;
  }
  console.log(`Moved ${move.from} → ${move.to}`);
}

/** The cluster's direct connection (not PgBouncer's), from the rewritten database.json. */
function readConnection(
  root: string,
  moves: readonly Move[],
): DatabaseConfig["connection"] {
  const path =
    rewriteDbValue(DATABASE_CONFIG_PATH, moves) ?? DATABASE_CONFIG_PATH;
  const config = JSON.parse(readFileSync(path, "utf8")) as DatabaseConfig;
  if (!config.connection.host.startsWith(root)) {
    console.log(
      `Note: the database connection (${config.connection.host}) is not under ${root}.`,
    );
  }
  return config.connection;
}

/** Start Postgres alone from its rewritten launch (the argv the gateway's supervisor runs). */
async function startPostgres(
  root: string,
  moves: readonly Move[],
): Promise<void> {
  const path =
    rewriteDbValue(DATABASE_CONFIG_PATH, moves) ?? DATABASE_CONFIG_PATH;
  const config = JSON.parse(readFileSync(path, "utf8")) as {
    services?: { name: string; start: string[] }[];
  };
  const postgres = config.services?.find((s) => s.name === "postgres");
  if (postgres === undefined) {
    throw new Error(
      `${path} declares no postgres service, so this install's database is not the embedded cluster — its stored paths cannot be rewritten from here.`,
    );
  }
  const res = await spawnPassthrough(postgres.start, { cwd: root });
  if (res.exitCode !== 0) {
    throw new Error(
      `starting Postgres (${postgres.start.join(" ")}) exited ${res.exitCode}`,
    );
  }
}

async function apply(plan: MigratePlan, facts: MigrationFacts): Promise<void> {
  const checkout = await getWorktreeRoot();
  try {
    await applyStopped(plan, facts, checkout);
  } catch (err) {
    // Whatever step failed, the legacy name still resolves (it stays a link
    // until the scan is clean), so the app runs on the moved root as it is:
    // bring it back before reporting, and the rerun finishes the job.
    console.error(
      `\nThe migration stopped: ${err instanceof Error ? err.message : String(err)}\nStarting the app again; rerun \`./${CLI_NAME} data-dir migrate --apply\` once the cause is fixed.`,
    );
    await equin(checkout, "start");
    throw err;
  }
}

async function applyStopped(
  plan: MigratePlan,
  facts: MigrationFacts,
  checkout: string,
): Promise<void> {
  const layout = facts.layout as DataRootLayout;
  const oldRoot = layout.root;
  const newRoot = plan.root?.to ?? oldRoot;

  step("Stopping the app");
  await equin(checkout, "stop");
  // SIGTERM is an agent's clean exit: it records that it exited and removes
  // its pid file, and its conversation relaunches it on the next message.
  for (const agent of plan.stopAgents) {
    await stopByPid(agent.what, agent.pid, "SIGTERM", 60_000);
  }
  await stopByPidFile(
    "PgBouncer",
    pgbouncerPidFileUnder(oldRoot),
    "SIGTERM",
    30_000,
  );
  // SIGINT is Postgres's fast shutdown: clients disconnected, a clean
  // checkpoint, no crash recovery at the next start (SIGQUIT would need one).
  await stopByPidFile(
    "Postgres",
    pgPostmasterPidFile(oldRoot),
    "SIGINT",
    10 * 60_000,
  );

  // Anything that started between the first check and the stop (a gateway
  // relaunching an agent) is caught here, before a byte moves.
  const late = [...(await liveOps()), ...liveAgents()];
  if (late.length > 0) {
    console.error(
      `Something started while the app was stopping; nothing was moved:\n${late.map((w) => `  - ${w.what}`).join("\n")}`,
    );
    throw new Error("something started while the app was stopping");
  }

  if (plan.root) {
    step("Moving the data root");
    moveAndLink(plan.root);
  }
  if (plan.backups) moveAndLink(plan.backups);

  if (plan.rewrite.length > 0) {
    step(`Rewriting stored paths under ${newRoot}`);
    const files = visitFiles(newRoot, plan.rewrite, true);
    console.log(
      `Files: ${files.text.length} rewritten, ${files.links.length} links re-pointed, ${files.cacheEntries.length} cache entries dropped (rebuilt on demand).`,
    );

    step("Starting Postgres alone, to rewrite the databases");
    await startPostgres(newRoot, plan.rewrite);
    const conn = readConnection(newRoot, plan.rewrite);
    const databases = await listDatabases(conn);
    for (const [i, database] of databases.entries()) {
      const rows = await rewriteDatabase(conn, database, plan.rewrite);
      console.log(
        `  [${i + 1}/${databases.length}] ${database}: ${rows} rows rewritten`,
      );
    }

    const projects = moveClaudeProjects(
      CLAUDE_PROJECTS_DIR,
      plan.rewrite,
      true,
    );
    console.log(
      `Claude Code transcript dirs: ${projects.filter((p) => !p.conflict).length} renamed.`,
    );

    step("Scanning for anything still naming the old paths");
    const left = visitFiles(newRoot, plan.rewrite, false);
    // One database at a time: each scan reads every text column of every
    // table, and ~170 of them at once would only fight over the disk.
    const dbLeft: DbLeftover[] = [];
    for (const database of databases) {
      dbLeft.push(...(await scanDatabase(conn, database, plan.rewrite)));
    }
    const conflicts = projects.filter((p) => p.conflict);
    const leftovers = [
      ...left.text.map((f) => `file ${f}`),
      ...left.links.map((f) => `link ${f}`),
      ...left.cacheEntries.map((f) => `cache entry ${f}`),
      ...dbLeft.map((d) => `${d.database}: ${d.column} (${d.rows} rows)`),
      ...conflicts.map(
        (c) =>
          `Claude Code dir ${basename(c.from)} (${basename(c.to)} exists too)`,
      ),
    ];
    if (left.binaries.length > 0) {
      console.log(
        `Binaries naming an old path (build-path strings; not editable, not used to find anything):\n${left.binaries.map((b) => `  - ${b}`).join("\n")}`,
      );
    }
    if (leftovers.length === 0) {
      for (const link of plan.dropLinks) unlinkSync(link);
      console.log(`Clean: removed ${plan.dropLinks.join(" and ")}.`);
    } else {
      console.log(
        `Still naming an old path — kept ${plan.dropLinks.join(" and ")} as ${plan.dropLinks.length > 1 ? "links" : "a link"} so they keep resolving:\n${leftovers.map((l) => `  - ${l}`).join("\n")}\n` +
          `Handle these, then rerun \`./${CLI_NAME} data-dir migrate --apply\`: it repeats the rewrite and removes the link once nothing is left.`,
      );
    }
  }

  if (plan.relabel) {
    step("Relabelling the gateway's service");
    const manager = loginServiceManager();
    if (manager === null)
      throw new Error("unreachable: an old label was found installed");
    const old = manager.service({
      label: LEGACY_IDS.launchdLabel,
      session: GATEWAY_SERVICE.session,
    });
    if ((await old.state()).kind === "loaded") await old.unload();
    await old.remove();
    console.log(`Removed ${old.definitionPath()}`);
  }

  step("Starting the app");
  await equin(checkout, "start");
  // After the start, which rewrote the app's own launchd / systemd jobs: what
  // still names an old path out there is the user's.
  reportOutside(plan.rewrite);
}

/**
 * Mentions of the old paths in places this command does not own — the user's
 * own launchd jobs and shell startup files — listed so they can be edited by
 * hand. Nothing here is changed.
 */
function reportOutside(moves: readonly Move[]): void {
  const candidates = [
    ...listDir(join(HOME_DIR, "Library", "LaunchAgents")),
    ...[".zshrc", ".zprofile", ".bashrc", ".bash_profile", ".profile"].map(
      (f) => join(HOME_DIR, f),
    ),
    join(HOME_DIR, ".claude", "settings.json"),
  ];
  const hits = candidates.filter((path) => {
    if (!existsSync(path) || !lstatSync(path).isFile()) return false;
    const text = readFileSync(path, "utf8");
    return moves.some((m) => text.includes(m.from));
  });
  if (hits.length > 0) {
    console.log(
      `Outside the data root, these still mention an old path (not changed — edit them if they matter):\n${hits.map((h) => `  - ${h}`).join("\n")}`,
    );
  }
}

function listDir(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).map((name) => join(dir, name)) : [];
}
