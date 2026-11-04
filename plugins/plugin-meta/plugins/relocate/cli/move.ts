import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { rmdirSync } from "node:fs";
import {
  existsSync,
  readdirSync,
  readFile,
} from "@plugins/packages/plugins/timed-fs/core";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configDir } from "@plugins/config_v2/data-dirs";
import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { asPath, asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import { loadRepoFiles } from "@plugins/framework/plugins/tooling/core";
import {
  getMainRepoRoot,
  getWorktreeRoot,
  spawnExpectOk,
} from "@plugins/infra/plugins/spawn/core";
import {
  findPluginMentions,
  findPluginRefs,
} from "@plugins/plugin-meta/plugins/plugin-refs/core";
import { buildStructureTreeOnce } from "@plugins/plugin-meta/plugins/plugin-tree/core";
import {
  PLUGIN_MOVES_FILE,
  appendPluginMove,
  namespacesHolding,
  parsePluginMoves,
  pluginMoveKey,
  readPluginMoves,
} from "../core";
import {
  editFor,
  locationOf,
  mapRepoPath,
  parsePluginArg,
  planMove,
  type Move,
  type MovePlan,
} from "./internal/plan";
import {
  judgeDirt,
  parsePorcelainZ,
  readTouched,
  recordTouched,
} from "./internal/touched";

/** Local git metadata reads and renames. */
const GIT_TIMEOUT_MS = 60_000;

function refuse(message: string): never {
  console.error(`plugin move: ${message}`);
  process.exit(1);
}

function parseOrRefuse(arg: string): ReturnType<typeof parsePluginArg> {
  try {
    return parsePluginArg(arg);
  } catch (err) {
    if (err instanceof Error) refuse(err.message);
    throw err;
  }
}

async function git(root: string, args: string[]): Promise<string> {
  return (
    await spawnExpectOk(["git", ...args], {
      cwd: root,
      timeoutMs: GIT_TIMEOUT_MS,
    })
  ).stdout;
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

function printPlan(plan: MovePlan, dryRun: boolean): void {
  const { move } = plan;
  const verb = dryRun ? "Would move" : "Moving";
  console.log(`${verb} ${move.from.id} → ${move.to.id}`);
  console.log(`  ${move.from.dir} → ${move.to.dir}`);
  console.log(``);
  console.log(`Plugins (${plan.plugins.length}):`);
  for (const p of plan.plugins) console.log(`  ${p.from} → ${p.to}`);
  console.log(``);
  console.log(`git mv:`);
  for (const r of plan.renames) console.log(`  ${r.from} → ${r.to}`);
  console.log(``);

  const total = [...plan.counts.values()].reduce((a, b) => a + b, 0);
  console.log(
    `References (${plural(total, "edit")} in ${plural(plan.rewrites.length, "file")}):`,
  );
  for (const [kind, n] of [...plan.counts].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    console.log(`  ${kind.padEnd(28)} ${n}`);
  }
  console.log(``);
  console.log(`Files:`);
  for (const r of plan.rewrites) {
    const where = r.newFile === r.file ? r.file : `${r.file} → ${r.newFile}`;
    console.log(`  ${String(r.edits.length).padStart(3)}  ${where}`);
  }
  console.log(``);
  console.log(`package.json names (${plan.packages.length}):`);
  for (const p of plan.packages)
    console.log(`  ${p.newFile}: ${p.from} → ${p.to}`);

  if (plan.dotMentions.length > 0) {
    console.log(``);
    console.log(
      `REVIEW — these name ${move.from.id} by its dot id in free text, and are left as written.`,
    );
    console.log(
      `A dot id can be a stored identity (a job name, a row's plugin id): rewrite each, migrate`,
    );
    console.log(
      `the data stored under it, or exempt it — \`relocate:moved-plugins-unnamed\` fails until then:`,
    );
    for (const m of plan.dotMentions)
      console.log(`  ${m.file}:${m.line}  ${m.value}`);
  }

  if (plan.narrowedGlobs.length > 0) {
    console.log(``);
    console.log(
      `WARNING — these globs covered the plugin at its old location and will not at the new one.`,
    );
    console.log(`Nothing fails when a glob narrows; widen or add one by hand:`);
    for (const g of plan.narrowedGlobs) {
      console.log(
        `  ${g.ref.file}:${g.ref.line}  ${g.ref.value}  (→ ${g.target})`,
      );
    }
  }
}

/**
 * Files in the moved subtree that locate other files relative to their own
 * directory at runtime. A depth change breaks them and no locator can rewrite
 * them (the path is computed, not written), so they are listed for review.
 */
function selfLocatingFiles(
  files: readonly string[],
  texts: Map<string, string>,
): string[] {
  const re = /import\.meta\.(?:dir|dirname|url)\b|__dirname/;
  return files.filter((f) => re.test(texts.get(f) ?? ""));
}

/** Ledger entries the working tree has and HEAD does not: this diff's moves. */
async function uncommittedMoves(root: string) {
  const working = readPluginMoves(asAppPath(root));
  // A HEAD that predates the ledger has committed no move.
  const tracked =
    (await git(root, ["ls-tree", "HEAD", "--", PLUGIN_MOVES_FILE])).trim() !==
    "";
  const committed = new Set(
    tracked
      ? parsePluginMoves(
          await git(root, ["show", `HEAD:${PLUGIN_MOVES_FILE}`]),
        ).map(pluginMoveKey)
      : [],
  );
  return working.filter((m) => !committed.has(pluginMoveKey(m)));
}

/** Remove `dir` and each parent up to (not including) `stop` while empty. */
function pruneEmpty(dir: string, stop: string): void {
  let d = dir;
  while (
    d.startsWith(`${stop}/`) &&
    existsSync(d) &&
    readdirSync(d).length === 0
  ) {
    rmdirSync(d);
    d = dirname(d);
  }
}

const run: CliAction<[string, string], { dryRun?: boolean }> = async (
  fromArg,
  toArg,
  opts,
) => {
  const dryRun = opts.dryRun === true;
  const root = await getWorktreeRoot();

  if (root === (await getMainRepoRoot())) {
    refuse(
      "refusing to run in the main checkout. Main rebuilds itself the moment its ref moves; " +
        "move the plugin in a worktree and land it with `./equin push`.",
    );
  }

  const from = parseOrRefuse(fromArg);
  const to = parseOrRefuse(toArg);
  const move: Move = { from, to };

  const gitDir = join(
    root,
    (await git(root, ["rev-parse", "--git-dir"])).trim(),
  );
  const verdict = judgeDirt({
    dirty: parsePorcelainZ(
      await git(root, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]),
    ),
    uncommitted: await uncommittedMoves(root),
    touched: readTouched(gitDir),
    always: [PLUGIN_MOVES_FILE],
  });
  if (verdict.kind === "unexplained") {
    const message =
      "the tree has uncommitted changes no earlier move in this diff made. A move rewrites hundreds " +
      "of files; on a tree holding only moves, `git diff HEAD` shows exactly what they did, and nothing else.";
    const listed = verdict.paths.map((p) => `  ${p}`).join("\n");
    if (!dryRun)
      refuse(
        `${message}\n\n${listed}\n\nLand or set those changes aside first.`,
      );
    console.log(
      `note: ${message} (dry run — continuing, nothing is written)\n`,
    );
  } else if (verdict.kind === "chained") {
    console.log(
      `Chaining after ${plural(verdict.moves.length, "uncommitted move")} (${verdict.moves
        .map((m) => `${m.from} → ${m.to}`)
        .join(", ")}): every dirty path is one of theirs.\n`,
    );
  }

  if (from.id === to.id)
    refuse(`<from> and <to> are the same plugin (${from.id})`);

  const tree = await buildStructureTreeOnce(asAppPath(join(root, "plugins")));
  const fromNode = [...tree.byDir.values()].find((n) => n.id === from.id);
  if (fromNode === undefined) refuse(`${from.dir} is not a plugin`);

  if (to.id === from.id || to.id.startsWith(`${from.id}.`)) {
    refuse(
      `<to> (${to.id}) is inside <from> (${from.id}) — a plugin cannot move into itself`,
    );
  }
  if (existsSync(join(root, to.dir))) refuse(`${to.dir} already exists`);
  const toParentId = to.id.includes(".")
    ? to.id.slice(0, to.id.lastIndexOf("."))
    : null;
  if (
    toParentId !== null &&
    ![...tree.byDir.values()].some((n) => n.id === toParentId)
  ) {
    refuse(
      `the parent of <to>, ${locationOf(asPluginId(toParentId)).dir}, is not a plugin — ` +
        `a plugin lives directly under plugins/ or in an existing plugin's plugins/ folder`,
    );
  }
  if (existsSync(join(root, to.configDir))) {
    refuse(
      `${to.configDir} already exists — the moved plugin's config dir would land on it`,
    );
  }

  const moved = [...tree.byDir.values()].filter(
    (n) => n.id === from.id || n.id.startsWith(`${from.id}.`),
  );

  // Locate BEFORE anything moves: the refs carry old paths and old offsets.
  const repo = await loadRepoFiles(root);
  const refs = await findPluginRefs(repo);
  const mentions = await findPluginMentions(repo, [from.id]);
  const texts = new Map<string, string>();
  const need = new Set<string>([
    // Only files that get an edit are read; the rest of the repo's refs are
    // still handed to the planner (glob-coverage warnings read them all).
    ...refs.filter((r) => editFor(move, r) !== null).map((r) => r.file),
    ...mentions.map((m) => m.file),
    ...moved.map((n) => `${locationOf(n.id).dir}/package.json`),
  ]);
  const movedFiles = repo.under(from.dir);
  for (const f of movedFiles)
    if (f.endsWith(".ts") || f.endsWith(".tsx")) need.add(f);
  await Promise.all(
    [...need].map(async (f) => {
      const text = await repo.read(f);
      if (text !== null) texts.set(f, text);
    }),
  );

  const plan = planMove({
    move,
    movedIds: moved.map((n) => n.id),
    compositionRoots: new Set(
      moved.filter((n) => n.compositionRoot).map((n) => n.id),
    ),
    hasConfigDir: repo.under(from.configDir).length > 0,
    refs,
    mentions,
    read: (f) => texts.get(f) ?? null,
  });

  printPlan(plan, dryRun);

  const selfLocating = selfLocatingFiles(movedFiles, texts);
  const depthChange = to.dir.split("/").length !== from.dir.split("/").length;
  if (depthChange && selfLocating.length > 0) {
    console.log(``);
    console.log(
      `REVIEW — the plugin changes depth, and these files compute paths from their own location`,
    );
    console.log(
      `(import.meta.dir / __dirname); a "../" count in them may now be off:`,
    );
    for (const f of selfLocating) console.log(`  ${f}`);
  }

  if (!dryRun) {
    for (const r of plan.renames) {
      await mkdir(dirname(join(root, r.to)), { recursive: true });
      await git(root, ["mv", r.from, r.to]);
      pruneEmpty(
        dirname(join(root, r.from)),
        join(root, r.from.split("/")[0]!),
      );
    }
    for (const r of plan.rewrites)
      await writeFile(join(root, r.newFile), r.text);
    for (const p of plan.packages) {
      // A package.json no ref touched is read fresh at its new path; one a ref
      // edit also rewrote would already carry that text — never the case today.
      const current = await readFile(join(root, p.newFile), "utf8");
      if (current !== texts.get(p.file)) {
        throw new Error(
          `${p.newFile} changed during the move — refusing to overwrite it`,
        );
      }
      await writeFile(join(root, p.newFile), p.text);
    }
  }

  // Saved settings are not moved here: each namespace's copy is migrated by its
  // own next build, from the ledger entry committed alongside this move — so the
  // settings change exactly when the code that reads them does.
  if (!dryRun) {
    const entry = appendPluginMove(root, { from: from.id, to: to.id });
    // What the next move may find dirty because of this one: every moved file
    // at both paths, every rewrite, and the lockfile the next install rewrites
    // from the renamed workspaces.
    recordTouched(gitDir, entry, [
      ...[...repo.under(from.dir), ...repo.under(from.configDir)].flatMap(
        (f) => [f, mapRepoPath(move, f)],
      ),
      ...plan.rewrites.flatMap((r) => [r.file, r.newFile]),
      ...plan.packages.map((p) => p.newFile),
      PLUGIN_MOVES_FILE,
      "bun.lock",
    ]);
  }
  const holding = namespacesHolding(configDir.path, from.id);
  console.log(``);
  console.log(
    `${dryRun ? "Would record" : "Recorded"} ${from.id} → ${to.id} in ${PLUGIN_MOVES_FILE}. ` +
      `Each namespace's next \`./equin build\` moves its saved settings from ` +
      `${asPath(from.id)} to ${asPath(to.id)} and rewrites saved reorder keys` +
      (holding.length > 0
        ? ` — namespaces with settings there now: ${holding.join(", ")}.`
        : ` — no namespace has settings there now.`),
  );
  console.log(
    `plugin_health_reviews rows are keyed by plugin id; rows for the old ids orphan (not migrated). ` +
      `To see them: SELECT plugin_id, axis FROM plugin_health_reviews WHERE plugin_id IN (${plan.plugins
        .map((p) => `'${p.from}'`)
        .join(", ")});`,
  );
  console.log(``);
  if (dryRun) {
    console.log(`Dry run — nothing was moved or written.`);
  } else {
    console.log(
      `Moved. Next: \`./equin build\` (regenerates registries, docs, CLAUDE.md blocks and bun.lock), ` +
        `then \`./equin check\`. \`git diff HEAD\` shows every rename and edit.`,
    );
  }
};

export default run;
