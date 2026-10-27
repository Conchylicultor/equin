import {
  readEnv,
  setEnv,
  unsetEnv,
} from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { worktreeDataDir } from "@plugins/infra/plugins/paths/server";
import { asNamespace } from "@plugins/infra/plugins/namespace/core";
import { flockTry } from "@plugins/packages/plugins/flock/core";
import { spawnExpectOk } from "@plugins/infra/plugins/spawn/core";
import { releaseCheckoutsDir } from "../../data-dirs";
import {
  acquireReleaseCheckout,
  isReleaseCheckout,
  releaseCheckoutPath,
  removeCheckoutArtifacts,
  sweepLeakedReleaseCheckouts,
} from "./source-checkout";

// Hermetic: the data root points at a throwaway dir, so no checkout, lock file,
// scratch namespace dir or host-pool slot file lands under the real
// `~/.equin`. The root is read at call time, so setting it here — before
// any test body runs — is enough.
const ORIGINAL_DATA_ROOT = readEnv("DIR");
const dataRoot = mkdtempSync(join(tmpdir(), "release-source-checkout-root-"));
setEnv("DIR", dataRoot);
const repo = mkdtempSync(join(tmpdir(), "release-source-checkout-repo-"));

/** The rejection message of `promise`; fails the test when it resolves. */
async function rejectionOf(promise: Promise<unknown>): Promise<string> {
  const outcome = await promise.then(
    () => ({ rejected: false as const }),
    (err: unknown) => ({ rejected: true as const, err }),
  );
  if (!outcome.rejected) throw new Error("expected the promise to reject");
  return String(outcome.err);
}

let firstSha = "";
let secondSha = "";

async function git(...args: string[]): Promise<string> {
  const { stdout } = await spawnExpectOk(["git", "-C", repo, ...args], {
    timeoutMs: 60_000,
  });
  return stdout.trim();
}

/** Whether git still registers a worktree whose basename is `path`'s. */
async function worktreeListIncludes(path: string): Promise<boolean> {
  const out = await git("worktree", "list", "--porcelain");
  const name = basename(path);
  return out
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .some((l) => basename(l.slice("worktree ".length)) === name);
}

beforeAll(async () => {
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "test");
  await git("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "file.txt"), "first\n");
  await git("add", "file.txt");
  await git("commit", "-q", "-m", "first");
  firstSha = await git("rev-parse", "HEAD");
  writeFileSync(join(repo, "file.txt"), "second\n");
  await git("commit", "-q", "-am", "second");
  secondSha = await git("rev-parse", "HEAD");
});

afterAll(() => {
  if (ORIGINAL_DATA_ROOT === undefined) unsetEnv("DIR");
  else setEnv("DIR", ORIGINAL_DATA_ROOT);
  rmSync(dataRoot, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe("acquireReleaseCheckout", () => {
  test("creates a detached checkout at the pinned sha, not at HEAD", async () => {
    const checkout = await acquireReleaseCheckout({
      sourceRoot: repo,
      sha: firstSha,
      name: "release-1-acquire",
    });
    try {
      expect(checkout.root).toBe(
        join(releaseCheckoutsDir.path, "release-1-acquire"),
      );
      expect(readFileSync(join(checkout.root, "file.txt"), "utf8")).toBe(
        "first\n",
      );
      const head = await spawnExpectOk(
        ["git", "-C", checkout.root, "rev-parse", "HEAD"],
        {
          timeoutMs: 60_000,
        },
      );
      expect(head.stdout.trim()).toBe(firstSha);
      expect(head.stdout.trim()).not.toBe(secondSha);
      // Detached: no branch is checked out.
      const branch = await spawnExpectOk(
        ["git", "-C", checkout.root, "symbolic-ref", "-q", "--short", "HEAD"],
        { timeoutMs: 60_000 },
      ).catch((err: unknown) => err);
      expect(branch).toBeInstanceOf(Error);
      expect(isReleaseCheckout(checkout.root)).toBe(true);
    } finally {
      await checkout.dispose();
    }
  });

  test("the owner holds the lock for the checkout's whole life", async () => {
    const checkout = await acquireReleaseCheckout({
      sourceRoot: repo,
      sha: firstSha,
      name: "release-2-locked",
    });
    try {
      // flock(2) conflicts across open file descriptions even within one process.
      const fd = openSync(`${checkout.root}.lock`, "a");
      try {
        expect(flockTry(fd)).toBe(false);
      } finally {
        closeSync(fd);
      }
    } finally {
      await checkout.dispose();
    }
    expect(existsSync(`${checkout.root}.lock`)).toBe(false);
  });

  test("a sha the repo does not have fails loudly and leaves nothing behind", async () => {
    const name = "release-3-badsha";
    expect(
      await rejectionOf(
        acquireReleaseCheckout({ sourceRoot: repo, sha: "0".repeat(40), name }),
      ),
    ).toMatch(/git worktree add/);
    expect(existsSync(releaseCheckoutPath(name))).toBe(false);
    expect(existsSync(`${releaseCheckoutPath(name)}.lock`)).toBe(false);
  });

  test("refuses a name that is not a namespace label", async () => {
    expect(
      await rejectionOf(
        acquireReleaseCheckout({
          sourceRoot: repo,
          sha: firstSha,
          name: "../escape",
        }),
      ),
    ).toMatch(/Invalid checkout name/);
  });
});

describe("dispose", () => {
  test("removes the checkout, its git registration and its scratch data dir", async () => {
    const name = "release-4-dispose";
    const checkout = await acquireReleaseCheckout({
      sourceRoot: repo,
      sha: secondSha,
      name,
    });
    // What the inner build leaves: a release web dist / check transcript under
    // the scratch namespace, plus ignored files git does not track.
    const scratch = worktreeDataDir(asNamespace(name));
    mkdirSync(join(scratch, "release-web"), { recursive: true });
    writeFileSync(join(scratch, "leftover.txt"), "x");
    mkdirSync(join(checkout.root, "node_modules"), { recursive: true });
    writeFileSync(join(checkout.root, "node_modules", "dep.js"), "x");
    expect(await worktreeListIncludes(checkout.root)).toBe(true);

    await checkout.dispose();

    expect(existsSync(checkout.root)).toBe(false);
    expect(existsSync(scratch)).toBe(false);
    expect(await worktreeListIncludes(checkout.root)).toBe(false);
    // Idempotent.
    await checkout.dispose();
  });

  test("refuses to remove a path outside the release-checkouts dir", async () => {
    const outside = mkdtempSync(
      join(tmpdir(), "release-source-checkout-outside-"),
    );
    const victim = join(outside, "release-5-victim");
    mkdirSync(victim);
    writeFileSync(join(victim, "keep.txt"), "keep");
    try {
      expect(await rejectionOf(removeCheckoutArtifacts(repo, victim))).toMatch(
        /refusing to remove/,
      );
      // A nested path under the dir is not a direct child either.
      const nested = join(releaseCheckoutsDir.path, "release-5-a", "sub");
      expect(await rejectionOf(removeCheckoutArtifacts(repo, nested))).toMatch(
        /refusing to remove/,
      );
      expect(readFileSync(join(victim, "keep.txt"), "utf8")).toBe("keep");
      expect(isReleaseCheckout(victim)).toBe(false);
      expect(isReleaseCheckout(releaseCheckoutsDir.path)).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("sweepLeakedReleaseCheckouts", () => {
  test("removes an entry whose lock is free and keeps one whose lock is held", async () => {
    const live = await acquireReleaseCheckout({
      sourceRoot: repo,
      sha: firstSha,
      name: "release-6-live",
    });
    try {
      // A leaked checkout: created, registered, lock file present, no holder —
      // what a SIGKILLed release leaves behind.
      const leaked = join(releaseCheckoutsDir.path, "release-6-leaked");
      await git("worktree", "add", "-q", "--detach", leaked, secondSha);
      writeFileSync(`${leaked}.lock`, "");
      const leakedScratch = worktreeDataDir(asNamespace("release-6-leaked"));
      mkdirSync(leakedScratch, { recursive: true });
      // An acquire that died between its lock and its `worktree add`.
      writeFileSync(
        join(releaseCheckoutsDir.path, "release-6-lockonly.lock"),
        "",
      );

      const result = await sweepLeakedReleaseCheckouts(repo);

      expect(result.failed).toEqual([]);
      expect(result.removed.sort()).toEqual([
        "release-6-leaked",
        "release-6-lockonly",
      ]);
      expect(result.live).toEqual(["release-6-live"]);
      expect(existsSync(leaked)).toBe(false);
      expect(existsSync(`${leaked}.lock`)).toBe(false);
      expect(existsSync(leakedScratch)).toBe(false);
      expect(await worktreeListIncludes(leaked)).toBe(false);
      expect(
        existsSync(join(releaseCheckoutsDir.path, "release-6-lockonly.lock")),
      ).toBe(false);
      // The live checkout is untouched and still locked.
      expect(readFileSync(join(live.root, "file.txt"), "utf8")).toBe("first\n");
      expect(existsSync(`${live.root}.lock`)).toBe(true);
    } finally {
      await live.dispose();
    }
  });

  test("an empty or missing dir sweeps nothing", async () => {
    rmSync(releaseCheckoutsDir.path, { recursive: true, force: true });
    expect(await sweepLeakedReleaseCheckouts(repo)).toEqual({
      removed: [],
      live: [],
      failed: [],
    });
  });
});
