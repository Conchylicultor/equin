/**
 * The push's post-rebase hand-off, end to end: a push whose rebase brings in a
 * change to the push's OWN post-rebase code must run that NEW code
 * (research/2026-11-06-cli-push-post-rebase-handoff.md).
 *
 * The incident it guards: the push process kept running its pre-rebase code
 * after rebasing its own checkout, and died when the rebased tree no longer
 * matched what it relied on. Now everything after the rebase runs in the land
 * phase, a child on the rebased code; this proves which code ran by having main
 * change what the land phase prints.
 *
 * Fixture, all under one temp dir:
 *
 *   e2e-ph-<id>/      `git clone --shared` of THIS checkout, `main` = its HEAD
 *                     plus its uncommitted working tree (one overlay commit), no
 *                     remote — so push runs in local mode and locks in this
 *                     repository's own git dir, never the machine's push mutex.
 *   e2e-ph-<id>-wt/   a linked worktree on a branch off that main, holding one
 *                     commit — the work the push lands.
 *
 * Then main moves past the branch with one commit that makes the land phase
 * print a marker, and the worktree pushes. Expected: the push succeeds, prints
 * the marker (the land phase ran main's code, not the worktree's), and local
 * main holds both commits.
 *
 * Slow: the worktree's first CLI call installs its dependencies, and the push
 * runs the whole tree-scoped check pass.
 *
 * Run: ./equin run plugins/framework/plugins/cli/plugins/push/e2e/post-rebase-handoff.ts [--keep]
 */
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { envEntries } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { CLI_NAME } from "@plugins/framework/plugins/cli/plugins/cli-name/core";
import { PRODUCT_NAME } from "@plugins/framework/plugins/product-name/core";
import {
  getWorktreeRoot,
  spawnCaptured,
  type SpawnResult,
} from "@plugins/infra/plugins/spawn/core";

const GIT_TIMEOUT_MS = 120_000;
/** The first call installs the worktree's dependencies. */
const CLI_TIMEOUT_MS = 20 * 60_000;
/** A push runs the whole tree-scoped check pass (type-check included). */
const PUSH_TIMEOUT_MS = 45 * 60_000;

const LAND = "plugins/framework/plugins/cli/plugins/push/cli/land.ts";
/** The line main inserts at the top of the land phase. */
const LAND_ENTRY =
  "export async function landPush(payload: LandPayload): Promise<void> {\n";

let failures = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ✓ ${label}`);
    return;
  }
  failures += 1;
  console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
}

/** A broken fixture is not a test result: it stops the run. */
class FixtureError extends Error {}

let fixtureEnv: Record<string, string> = {};
const env = (): Record<string, string | undefined> => ({
  ...process.env,
  ...fixtureEnv,
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await spawnCaptured(["git", ...args], {
    cwd,
    env: env(),
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (r.exitCode !== 0)
    throw new FixtureError(
      `git ${args.join(" ")} failed in ${cwd} (exit ${r.exitCode}):\n${r.stderr}`,
    );
  return r.stdout.trim();
}

async function cli(
  cwd: string,
  args: string[],
  timeoutMs: number,
  logDir: string,
): Promise<SpawnResult> {
  const started = Date.now();
  const r = await spawnCaptured([`./${CLI_NAME}`, ...args], {
    cwd,
    env: env(),
    timeoutMs,
  });
  const log = join(logDir, `${args.join("_")}.log`);
  writeFileSync(
    log,
    `exit ${r.exitCode}${r.timedOut ? " (TIMED OUT)" : ""}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`,
  );
  const secs = ((Date.now() - started) / 1000).toFixed(0);
  console.log(
    `    $ ./${CLI_NAME} ${args.join(" ")} → exit ${r.exitCode} (${secs}s, ${log})`,
  );
  if (r.timedOut)
    throw new FixtureError(`./${CLI_NAME} ${args.join(" ")} timed out`);
  return r;
}

const output = (r: SpawnResult): string => `${r.stdout}\n${r.stderr}`;

/** `repo`'s main = the source's HEAD plus its uncommitted working tree. */
async function overlaySource(
  source: string,
  repo: string,
  tmp: string,
): Promise<void> {
  const diff = await spawnCaptured(["git", "diff", "HEAD", "--binary"], {
    cwd: source,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (diff.exitCode !== 0)
    throw new FixtureError(`git diff HEAD: ${diff.stderr}`);
  if (diff.stdout.trim()) {
    const patch = join(tmp, "overlay.patch");
    writeFileSync(patch, diff.stdoutBytes);
    await git(repo, "apply", "--binary", patch);
  }
  const untracked = (
    await git(source, "ls-files", "--others", "--exclude-standard", "-z")
  )
    .split("\0")
    .filter(Boolean);
  for (const rel of untracked) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    cpSync(join(source, rel), join(repo, rel));
  }
  if (await git(repo, "status", "--porcelain")) {
    await git(repo, "add", "-A");
    await git(
      repo,
      "commit",
      "-q",
      "-m",
      "e2e: overlay the source working tree",
    );
  }
}

/** What a real checkout gets before its first push: hooks + merge drivers. */
async function configureCheckout(repo: string): Promise<void> {
  await git(repo, "config", "--local", "core.hooksPath", ".githooks");
  for (const name of ["regen-generated", "regen-claudemd", "regen-migrations"])
    await git(
      repo,
      "config",
      "--local",
      `merge.${name}.driver`,
      `plugins/framework/plugins/cli/scripts/${name}.sh %O %A %B %P`,
    );
}

async function journey(
  tmp: string,
  source: string,
  logDir: string,
): Promise<void> {
  const id = randomBytes(3).toString("hex");
  const repo = join(tmp, `e2e-ph-${id}`);
  const wt = join(tmp, `e2e-ph-${id}-wt`);
  const marker = `push-handoff-e2e: land phase ran main's code (${id})`;
  fixtureEnv = {
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t.t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t.t",
    ...envEntries({ CONVERSATION_ID: `conv-e2e-ph-${id}` }),
    MISE_TRUSTED_CONFIG_PATHS: realpathSync(tmp),
  };

  console.log("Fixture (a copy of this tree):");
  await git(tmp, "clone", "-q", "--shared", "--no-checkout", source, repo);
  await git(
    repo,
    "checkout",
    "-q",
    "-f",
    "-B",
    "main",
    await git(source, "rev-parse", "HEAD"),
  );
  await git(repo, "remote", "remove", "origin");
  await overlaySource(source, repo, tmp);
  await configureCheckout(repo);
  await git(repo, "worktree", "add", "-q", "-b", "e2e-handoff", wt, "main");

  console.log(
    "  installing the worktree's dependencies (slow on first run)...",
  );
  const warm = await cli(wt, ["check", "--list"], CLI_TIMEOUT_MS, logDir);
  if (warm.exitCode !== 0) throw new FixtureError(`warm-up failed in ${wt}`);

  // The work the push lands.
  writeFileSync(
    join(wt, "research", `e2e-push-handoff-${id}.md`),
    `# e2e ${id}\n`,
  );
  await git(wt, "add", "-A");
  await git(wt, "commit", "-q", "-m", "e2e: the branch's work");

  // Main moves past the branch, changing what the land phase prints.
  const land = readFileSync(join(repo, LAND), "utf8");
  if (!land.includes(LAND_ENTRY))
    throw new FixtureError(`${LAND} no longer opens with: ${LAND_ENTRY}`);
  writeFileSync(
    join(repo, LAND),
    land.replace(
      LAND_ENTRY,
      `${LAND_ENTRY}  console.log(${JSON.stringify(marker)});\n`,
    ),
  );
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "e2e: main changes the land phase");
  const mainBefore = await git(repo, "rev-parse", "main");

  console.log("\nPush from the worktree:");
  const pushed = await cli(wt, ["push"], PUSH_TIMEOUT_MS, logDir);
  check("the push succeeds", pushed.exitCode === 0, `exit ${pushed.exitCode}`);
  check(
    "the land phase ran the rebased code (main's marker printed)",
    output(pushed).includes(marker),
  );
  check(
    "the land phase ran once",
    output(pushed).split("Done. e2e-handoff merged into local main").length ===
      2,
  );
  const head = await git(wt, "rev-parse", "HEAD");
  check(
    "local main is the pushed branch",
    (await git(repo, "rev-parse", "main")) === head,
  );
  check(
    "the branch was rebased onto main's land-phase change",
    (
      await spawnCaptured(
        ["git", "merge-base", "--is-ancestor", mainBefore, head],
        {
          cwd: repo,
          timeoutMs: GIT_TIMEOUT_MS,
        },
      )
    ).exitCode === 0,
  );
}

async function main(): Promise<void> {
  const keep = process.argv.includes("--keep");
  const source = await getWorktreeRoot();
  const tmp = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-push-handoff-`));
  const logDir = join(tmp, "logs");
  mkdirSync(logDir);
  try {
    await journey(tmp, source, logDir);
  } catch (err) {
    if (!(err instanceof FixtureError)) throw err;
    check("the fixture held", false, err.message);
  } finally {
    console.log(`  (CLI logs: ${logDir})`);
    if (keep || failures > 0) console.log(`(kept: ${tmp})`);
    else rmSync(tmp, { recursive: true, force: true });
  }
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll checks passed.");
}

await main();
