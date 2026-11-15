import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIT } from "@plugins/infra/plugins/paths/server";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { primeUntrackedCache } from "./untracked-cache";

// A throwaway repository — never the real checkout.
let repo: string;

async function git(
  env: Record<string, string>,
  ...args: string[]
): Promise<string> {
  const r = await spawnCaptured([GIT, "-C", repo, ...args], {
    timeoutMs: 60_000,
    env: { ...process.env, ...env },
  });
  if (r.exitCode !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout + r.stderr;
}

/** How many directories a read-only status (the app's readers') opens. */
async function opendirsOfReadOnlyStatus(): Promise<number> {
  const trace = await git(
    { GIT_TRACE2_PERF: "1" },
    "--no-optional-locks",
    "status",
    "--porcelain",
    "--untracked-files=normal",
    "-z",
  );
  const m = /opendir:(\d+)/.exec(trace);
  if (!m) throw new Error(`no opendir count in the trace:\n${trace}`);
  return Number(m[1]);
}

beforeEach(async () => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "untracked-cache-")));
  await git({}, "init", "-q", "-b", "main");
  await git({}, "config", "core.untrackedCache", "true");
  for (const d of ["a", "b", "c", "d", "e"]) {
    mkdirSync(join(repo, d, "x"), { recursive: true });
    writeFileSync(join(repo, d, "x", "f"), "1\n");
  }
  await git({}, "add", "-A");
  await git(
    {},
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-qm",
    "init",
  );
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

test("a read-only status never fills the cache: it opens every directory, every time", async () => {
  const first = await opendirsOfReadOnlyStatus();
  expect(first).toBeGreaterThanOrEqual(11);
  expect(await opendirsOfReadOnlyStatus()).toBe(first);
});

test("primed, a read-only status opens only the directories that changed", async () => {
  // git trusts no directory listing whose mtime is not older than the index
  // it is written to (racy git, whole seconds here): a real checkout's are
  // written seconds before its priming, this one's in the same second.
  await Bun.sleep(1100);
  // Under GIT_OPTIONAL_LOCKS=0, as every child of ours runs: the primer's
  // status writes a private index, never the checkout's own.
  expect(await primeUntrackedCache(repo)).toBe("published");
  expect(await opendirsOfReadOnlyStatus()).toBe(0);
  writeFileSync(join(repo, "b", "x", "new"), "n\n");
  // The changed directory only (its new file is untracked).
  expect(await opendirsOfReadOnlyStatus()).toBe(1);
});

test("a git writer holding index.lock keeps the real index untouched", async () => {
  await Bun.sleep(1100);
  writeFileSync(join(repo, ".git", "index.lock"), "");
  expect(await primeUntrackedCache(repo)).toBe("index-busy");
  rmSync(join(repo, ".git", "index.lock"));
  expect(await opendirsOfReadOnlyStatus()).toBeGreaterThanOrEqual(11);
});
