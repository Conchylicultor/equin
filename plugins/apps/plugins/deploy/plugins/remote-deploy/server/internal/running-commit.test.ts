/**
 * The running-commit fold against a scratch git repository: the behind count is
 * taken on `refs/heads/main` (not HEAD), and every arm that cannot name a
 * commit is `unknown`.
 *
 * Run: `./equin test plugins/apps/plugins/deploy/plugins/remote-deploy`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  countCommitsBehind,
  readCommitSubject,
  readRefSha,
} from "@plugins/release/plugins/bundles/server";
import {
  computeRunningCommit,
  MAIN_REF,
  type RunningCommitGit,
} from "./running-commit";

let repo: string;
let git: RunningCommitGit;

function run(...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
  }).trim();
}

function commit(subject: string): string {
  writeFileSync(join(repo, "f.txt"), `${subject}\n`);
  run("add", "f.txt");
  run(
    "commit",
    "-q",
    "-m",
    subject,
    "-m",
    "a body line that is not the subject",
  );
  return run("rev-parse", "HEAD");
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "running-commit-"));
  run("init", "-q", "-b", "main");
  run("config", "user.email", "t@example.com");
  run("config", "user.name", "t");
  run("config", "commit.gpgsign", "false");
  git = {
    subject: (sha) => readCommitSubject(sha, repo),
    mainSha: () => readRefSha(MAIN_REF, repo),
    behind: (sha, ref) => countCommitsBehind(sha, ref, repo),
  };
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("computeRunningCommit", () => {
  test("counts the commits on main the shipped sha lacks, not HEAD's", async () => {
    const shipped = commit("feat: the shipped one");
    commit("fix: second");
    const tip = commit("fix: third");
    // A side branch checked out ahead of main must not move the count.
    run("checkout", "-q", "-b", "side");
    commit("wip: on a branch");

    const answer = await computeRunningCommit(
      { kind: "shipped", runId: "drun-1", commitSha: shipped },
      git,
    );
    expect(answer).toEqual({
      kind: "known",
      sha: shipped,
      subject: "feat: the shipped one",
      behindMain: 2,
      mainSha: tip,
    });
    run("checkout", "-q", "main");
  });

  test("the main tip itself is 0 behind", async () => {
    const tip = run("rev-parse", MAIN_REF);
    const answer = await computeRunningCommit(
      { kind: "shipped", runId: "drun-2", commitSha: tip },
      git,
    );
    expect(answer).toMatchObject({
      kind: "known",
      behindMain: 0,
      mainSha: tip,
    });
  });

  test("a diverged sha counts main's commits it does not contain", async () => {
    const base = run("rev-parse", MAIN_REF);
    run("checkout", "-q", "-b", "diverged", base);
    const off = commit("feat: never merged");
    run("checkout", "-q", "main");
    commit("fix: main moves on");
    const answer = await computeRunningCommit(
      { kind: "shipped", runId: "drun-3", commitSha: off },
      git,
    );
    expect(answer).toMatchObject({ kind: "known", sha: off, behindMain: 1 });
  });

  test("nothing shipped yet is unknown", async () => {
    const answer = await computeRunningCommit({ kind: "none" }, git);
    expect(answer.kind).toBe("unknown");
  });

  test("a ship that recorded no commit is unknown, naming the run", async () => {
    const answer = await computeRunningCommit(
      { kind: "shipped", runId: "drun-4", commitSha: null },
      git,
    );
    expect(answer).toEqual({
      kind: "unknown",
      reason: "the run that shipped what is live (drun-4) recorded no commit",
    });
  });

  test("a sha this repository has never seen is unknown", async () => {
    const answer = await computeRunningCommit(
      {
        kind: "shipped",
        runId: "drun-5",
        commitSha: "0123456789abcdef0123456789abcdef01234567",
      },
      git,
    );
    expect(answer).toEqual({
      kind: "unknown",
      reason:
        "commit 0123456789abcdef0123456789abcdef01234567 is not known to this repository",
    });
  });
});
