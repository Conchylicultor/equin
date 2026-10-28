import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext } from "../context";
import type { Verdict } from "../types";
import { gitDiffMainGuard } from "./git-diff-main";

/** A repo whose `main` moved on after `branch` forked: merge-base ≠ main. */
let repo: string;
let base: string;
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const commit = (file: string) => {
  writeFileSync(join(repo, file), file);
  git("add", file);
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", file);
};

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "git-diff-main-"));
  git("init", "-q", "-b", "main");
  commit("a");
  base = git("rev-parse", "HEAD");
  git("checkout", "-qb", "branch");
  commit("b");
  git("checkout", "-q", "main");
  commit("c");
  git("checkout", "-q", "branch");
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

function verdict(command: string): Verdict {
  return gitDiffMainGuard.check({ command }, createContext(repo)) as Verdict;
}

describe("git-diff-main guard", () => {
  test("the one-revision form is rewritten to the merge-base sha", () => {
    const v = verdict("git diff --stat main -- a b | cat");
    expect(v.kind === "rewrite" && v.patch.command).toBe(
      `git diff --stat ${base} -- a b | cat`,
    );
    expect(v.kind === "rewrite" && v.note).toContain("refs/heads/main");
  });

  for (const command of [
    // Deliberate two-revision comparisons — what main gained, what a rebase brings.
    "git diff HEAD main",
    "git diff HEAD~1 main -- a",
    // Three dots already diff from the merge-base.
    "git diff main...HEAD",
    // The escape hatch.
    "git diff refs/heads/main",
    "git diff $(git merge-base HEAD main)",
    "git log main",
  ]) {
    test(`left alone: ${command}`, () => {
      expect(verdict(command).kind).toBe("allow");
    });
  }

  test("no rewrite once the branch contains main's tip", () => {
    git("rebase", "-q", "main");
    expect(verdict("git diff main").kind).toBe("allow");
  });
});
