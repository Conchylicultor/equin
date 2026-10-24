/**
 * The clone user's git journey, end to end, against real repositories.
 *
 * Builds a throwaway upstream + clone under the OS temp dir and drives the real
 * `resolvePublishTarget` / `resolveUpstreamRemote` / `fetchUpstreamStatus`
 * against them, then takes two updates in a row — because the second one is
 * what proves the landing rule: an update must import upstream's own commits,
 * not copies of them, or every later update re-presents work already merged.
 *
 * The clone is also given no commit identity of its own (no global or system
 * git config, none in the environment), the state of a fresh install: it must
 * still be able to sign a merge commit — with the local placeholder.
 *
 * It also asserts the author's case on THIS checkout: a checkout that may write
 * to its remote publishes as it always did and has no upstream. That one makes
 * a network call (a `--dry-run` push, which sends no update); everything else
 * is local filesystem repositories.
 *
 * Then the migration journey (`./migration-journey.ts`): a clone of THIS tree
 * lands its own schema migrations and takes an upstream update carrying
 * upstream's, through the real CLI. It tests this checkout's working tree,
 * uncommitted changes included; `--pristine` tests committed HEAD only.
 *
 * Run: ./equin run plugins/upstream/e2e/clone-journey.ts
 *        [--pristine]            migration journey against HEAD, no overlay
 *        [--skip-migrations]     only the (fast) text-fixture journey
 *        [--keep]                leave the temp repos and CLI logs behind
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureCommitIdentity,
  resolvePublishTarget,
  resolveUpstreamRemote,
} from "@plugins/infra/plugins/git/plugins/remotes/core";
import {
  spawnCaptured,
  spawnExpectOk,
  getWorktreeRoot,
} from "@plugins/infra/plugins/spawn/core";
import { fetchUpstreamStatus } from "@plugins/upstream/core";
import { runMigrationJourney } from "./migration-journey";

const GIT_TIMEOUT_MS = 60_000;

let failures = 0;

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ✓ ${label}`);
    return;
  }
  failures += 1;
  console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
}

/** Run git in `cwd`, exiting on failure: a broken fixture is not a test result. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await spawnCaptured(["git", ...args], {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t.t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t.t",
    },
  });
  if (result.exitCode !== 0) {
    console.error(`git ${args.join(" ")} failed in ${cwd}:\n${result.stderr}`);
    process.exit(1);
  }
  return result.stdout.trim();
}

/** Does `ref` sit in `branch`'s history — i.e. did that commit itself land? */
async function isAncestor(
  cwd: string,
  ref: string,
  branch: string,
): Promise<boolean> {
  const result = await spawnCaptured(
    ["git", "merge-base", "--is-ancestor", ref, branch],
    { cwd, timeoutMs: GIT_TIMEOUT_MS },
  );
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  console.error(`merge-base --is-ancestor failed: ${result.stderr}`);
  process.exit(1);
}

async function commit(
  cwd: string,
  file: string,
  body: string,
  message: string,
): Promise<string> {
  writeFileSync(join(cwd, file), `${body}\n`);
  await git(cwd, "add", "-A");
  await git(cwd, "commit", "-m", message);
  return await git(cwd, "rev-parse", "HEAD");
}

const IDENTITY_ENV = [
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "EMAIL",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
] as const;

/**
 * Run `fn` as a fresh install would: no global or system git config and no
 * identity in the environment. Scoped, because the author-side probe at the
 * end needs the real global config (credential helpers live there).
 */
async function withNoAmbientIdentity<T>(fn: () => Promise<T>): Promise<T> {
  const saved = IDENTITY_ENV.map((k) => [k, process.env[k]] as const);
  for (const k of IDENTITY_ENV) delete process.env[k];
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const known = ["--pristine", "--skip-migrations", "--keep"];
  const unknown = argv.filter((a) => !known.includes(a));
  if (unknown.length > 0) {
    console.error(
      `Unknown argument(s): ${unknown.join(" ")} (known: ${known.join(" ")})`,
    );
    process.exit(2);
  }
  const tmp = mkdtempSync(join(tmpdir(), "singularity-clone-journey-"));
  try {
    // --- the fixture: an upstream repo, and a clone of it whose only remote is
    // --- named `upstream` (the ordinary clone: nothing of its own to publish to).
    const upstream = join(tmp, "upstream");
    const clone = join(tmp, "clone");
    await git(tmp, "init", "-q", "-b", "main", upstream);
    await commit(upstream, "shared.txt", "base", "base");
    await git(tmp, "clone", "-q", upstream, clone);
    await git(clone, "remote", "rename", "origin", "upstream");

    console.log("\nA clone with nothing to publish to:");
    const target = await resolvePublishTarget(clone);
    check(
      "publishes nowhere",
      target.kind === "local",
      `got ${target.kind === "publish" ? `publish/${target.remote}` : ""}`,
    );
    const up = await resolveUpstreamRemote(clone);
    check(
      "receives from `upstream`",
      up.kind === "upstream" && up.remote === "upstream",
      JSON.stringify(up),
    );

    console.log("\nA clone whose user never configured git:");
    const signed = await withNoAmbientIdentity(async () => {
      const identity = await ensureCommitIdentity(clone, target);
      // A real merge commit, signed only by what ensureCommitIdentity left.
      const scratch = await commit(upstream, "sig.txt", "sig", "upstream: sig");
      await spawnExpectOk(["git", "fetch", "-q", "upstream"], {
        cwd: clone,
        timeoutMs: GIT_TIMEOUT_MS,
      });
      await spawnExpectOk(["git", "checkout", "-q", "-b", "signed", "main"], {
        cwd: clone,
        timeoutMs: GIT_TIMEOUT_MS,
      });
      await spawnExpectOk(["git", "merge", "--no-ff", "--no-edit", scratch], {
        cwd: clone,
        timeoutMs: GIT_TIMEOUT_MS,
      });
      const who = await spawnExpectOk(
        ["git", "log", "-1", "--format=%ae|%ce"],
        {
          cwd: clone,
          timeoutMs: GIT_TIMEOUT_MS,
        },
      );
      await spawnExpectOk(["git", "checkout", "-q", "main"], {
        cwd: clone,
        timeoutMs: GIT_TIMEOUT_MS,
      });
      return { identity, who: who.stdout.trim() };
    });
    check(
      "gets a local placeholder identity",
      signed.identity.kind === "auto" && signed.identity.written,
      JSON.stringify(signed.identity),
    );
    check(
      "signs a merge commit with it, author and committer",
      signed.identity.kind === "auto" &&
        signed.who === `${signed.identity.email}|${signed.identity.email}`,
      signed.who,
    );
    // Put upstream back where the rest of the journey expects it.
    await git(upstream, "reset", "-q", "--hard", "HEAD~1");
    await git(clone, "fetch", "-q", "--prune", "upstream");
    await git(clone, "branch", "-q", "-D", "signed");

    console.log("\nBefore upstream moves:");
    const current = await fetchUpstreamStatus(clone);
    check("is up to date", current.kind === "current", current.kind);

    // --- update #1: upstream moves, the clone merges it into a branch, and the
    // --- branch lands on main by fast-forward (what push does when main is an
    // --- ancestor). The user's own commit is there too, so the merge is real.
    await commit(clone, "mine.txt", "mine", "local: my own work");
    const upA = await commit(
      upstream,
      "shared.txt",
      "theirs",
      "upstream: first",
    );

    console.log("\nAfter upstream moves:");
    const behind = await fetchUpstreamStatus(clone);
    check(
      "reports behind by 1",
      behind.kind === "behind" && behind.count === 1,
      JSON.stringify(behind),
    );
    check(
      "names the newest commit",
      behind.kind === "behind" &&
        behind.newest[0]?.subject === "upstream: first",
      behind.kind === "behind" ? JSON.stringify(behind.newest) : behind.kind,
    );

    await git(clone, "checkout", "-q", "-b", "update-1", "main");
    await git(clone, "merge", "--no-edit", "upstream/main");
    await git(
      clone,
      "commit",
      "--amend",
      "--no-edit",
      "--trailer",
      "Singularity-Push=e2e-1",
    );
    await git(clone, "checkout", "-q", "main");
    await git(clone, "merge", "--ff-only", "update-1");

    console.log("\nAfter landing update 1:");
    check(
      "upstream's own commit is in main",
      await isAncestor(clone, upA, "main"),
      upA,
    );
    check(
      "the tip carries the push trailer",
      (
        await git(
          clone,
          "log",
          "-1",
          "--format=%(trailers:key=Singularity-Push,valueonly)",
          "main",
        )
      ).trim() === "e2e-1",
    );
    const settled = await fetchUpstreamStatus(clone);
    check("nothing is left behind", settled.kind === "current", settled.kind);

    // --- update #2: the one that would fail if update 1 had imported COPIES of
    // --- upstream's commits instead of upstream's commits.
    const upB = await commit(
      upstream,
      "second.txt",
      "more",
      "upstream: second",
    );
    const again = await fetchUpstreamStatus(clone);
    check(
      "only the new commit is behind",
      again.kind === "behind" && again.count === 1,
      JSON.stringify(again),
    );

    await git(clone, "checkout", "-q", "-b", "update-2", "main");
    const base = await git(clone, "merge-base", "main", "upstream/main");
    check(
      "the merge base is upstream's own last commit",
      base === upA,
      `${base} vs ${upA}`,
    );
    await git(clone, "merge", "--no-edit", "upstream/main");
    check(
      "update 2 merged without replaying update 1",
      await isAncestor(clone, upB, "HEAD"),
      upB,
    );

    // --- the author's case, on this checkout.
    console.log("\nThis checkout (the one that owns the repo):");
    const mine = await resolvePublishTarget(await getWorktreeRoot());
    check(
      "publishes to its remote",
      mine.kind === "publish",
      JSON.stringify(mine),
    );
    const mineUp = await resolveUpstreamRemote(await getWorktreeRoot());
    check(
      "has no upstream above it",
      mineUp.kind === "none" && mineUp.reason === "is-publisher",
      JSON.stringify(mineUp),
    );

    if (!argv.includes("--skip-migrations")) {
      await runMigrationJourney({
        tmp: join(tmp, "migrations"),
        source: await getWorktreeRoot(),
        pristine: argv.includes("--pristine"),
        check,
      });
    }
  } finally {
    if (argv.includes("--keep")) console.log(`\n(kept: ${tmp})`);
    else rmSync(tmp, { recursive: true, force: true });
  }

  console.log("");
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("All checks passed.");
}

await main();
