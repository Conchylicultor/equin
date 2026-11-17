import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdirSync,
  readFileSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIT } from "@plugins/infra/plugins/paths/server";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { stat } from "node:fs/promises";
import { countRacyEntries } from "../../core";
import { refreshCheckoutIndex, refreshIndexIfRacy } from "./refresh";

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
  repo = realpathSync(mkdtempSync(join(tmpdir(), "index-refresh-")));
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
  expect(await refreshCheckoutIndex(repo, "background")).toBe("published");
  expect(await opendirsOfReadOnlyStatus()).toBe(0);
  writeFileSync(join(repo, "b", "x", "new"), "n\n");
  // The changed directory only (its new file is untracked).
  expect(await opendirsOfReadOnlyStatus()).toBe(1);
});

test("a git writer holding index.lock keeps the real index untouched", async () => {
  await Bun.sleep(1100);
  writeFileSync(join(repo, ".git", "index.lock"), "");
  expect(await refreshCheckoutIndex(repo, "background")).toBe("index-busy");
  rmSync(join(repo, ".git", "index.lock"));
  expect(await opendirsOfReadOnlyStatus()).toBeGreaterThanOrEqual(11);
});

/** The racy count of the repo's index as countRacyEntries reads it. */
async function racyNow(): Promise<{ entries: number; racy: number }> {
  const index = join(repo, ".git", "index");
  const mtimeSec = Math.floor((await stat(index)).mtimeMs / 1000);
  return countRacyEntries(new Uint8Array(readFileSync(index)), mtimeSec);
}

test("an index written in the same second as its files is racy; refreshIndexIfRacy makes it trusted, once", async () => {
  // The commit above wrote the index in the files' own second.
  expect(await racyNow()).toEqual({ entries: 5, racy: 5 });
  const first = await refreshIndexIfRacy(repo);
  expect(first).toEqual({
    kind: "refreshed",
    entries: 5,
    racy: 5,
    publish: "published",
  });
  expect(await racyNow()).toEqual({ entries: 5, racy: 0 });
  // Trusted now: no refresh, no index write.
  expect(await refreshIndexIfRacy(repo)).toEqual({
    kind: "trusted",
    entries: 5,
  });
});

test("countRacyEntries reads index versions 3 and 4 the same as 2", async () => {
  // Every entry older than the index: none racy, whatever the version.
  await Bun.sleep(1100);
  for (const version of ["2", "3", "4"]) {
    await git({}, "update-index", "--index-version", version);
    await git({}, "update-index", "--refresh", "-q");
    // Pretend the index was written in the files' second: all racy.
    const index = join(repo, ".git", "index");
    const bytes = new Uint8Array(readFileSync(index));
    expect(countRacyEntries(bytes, 0)).toEqual({ entries: 5, racy: 5 });
    expect(await racyNow()).toEqual({ entries: 5, racy: 0 });
  }
});

test("countRacyEntries refuses what is not an index", () => {
  expect(() => countRacyEntries(new Uint8Array(16), 0)).toThrow(
    "not a git index",
  );
});
