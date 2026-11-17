import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnExpectOk } from "@plugins/infra/plugins/spawn/core";
import {
  fetchUpstreamStatus,
  isCouldNotAsk,
  readOwnReleases,
  releasesHolding,
  standingAgainst,
} from "./status";

describe("isCouldNotAsk", () => {
  test("a remote nobody could reach is a state, not a bug", () => {
    expect(isCouldNotAsk("unreachable")).toBe(true);
  });

  test("a remote that never learned who we are is the same fact", () => {
    // It said nothing about whether updates exist, so there is nothing to
    // report and nothing to throw about.
    expect(isCouldNotAsk("no-credentials")).toBe(true);
  });

  test("a refused read stays loud", () => {
    // The remote recognised us and said no: a repo deleted, made private, or a
    // typo'd URL. That does not fix itself, so it must not be filed as weather.
    expect(isCouldNotAsk("denied")).toBe(false);
  });

  test("a failure nothing classified stays loud", () => {
    expect(isCouldNotAsk("unclassified")).toBe(false);
  });
});

// --- fetchUpstreamStatus over real repositories: an upstream, and a clone of
// --- it whose only remote is a filesystem path (so it publishes nowhere and
// --- receives from `upstream`). No network.

const tmp = mkdtempSync(join(tmpdir(), "upstream-status-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t.t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t.t",
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await spawnExpectOk(["git", ...args], {
    cwd,
    timeoutMs: 60_000,
    env: ENV,
  });
  return r.stdout.trim();
}

async function commit(cwd: string, file: string, body: string): Promise<void> {
  writeFileSync(join(cwd, file), `${body}\n`);
  await git(cwd, "add", "-A");
  await git(cwd, "commit", "-q", "-m", body);
}

async function release(cwd: string, tag: string): Promise<void> {
  await git(cwd, "tag", "-a", tag, "-m", `release ${tag}`);
}

async function fixture(name: string): Promise<{ up: string; clone: string }> {
  const up = join(tmp, `${name}-up`);
  const clone = join(tmp, `${name}-clone`);
  await git(tmp, "init", "-q", "-b", "main", up);
  await commit(up, "a.txt", "base");
  await git(tmp, "clone", "-q", up, clone);
  await git(clone, "remote", "rename", "origin", "upstream");
  return { up, clone };
}

describe("fetchUpstreamStatus", () => {
  test("no release upstream: nothing to tell, however far main moved", async () => {
    const { up, clone } = await fixture("none");
    await commit(up, "b.txt", "upstream moves");
    const s = await fetchUpstreamStatus(clone);
    expect(s).toMatchObject({ kind: "no-release", current: null });
  });

  test("behind a new release, then current once it is merged", async () => {
    const { up, clone } = await fixture("behind");
    await release(up, "v2026.10.30");
    await git(clone, "fetch", "-q", "upstream", "--tags");
    await git(clone, "merge", "-q", "--ff-only", "upstream/main");
    await commit(up, "b.txt", "feature");
    await release(up, "v2026.11.14");

    const behind = await fetchUpstreamStatus(clone);
    expect(behind).toMatchObject({
      kind: "behind",
      current: "v2026.10.30",
      latest: "v2026.11.14",
      commits: 1,
    });
    expect(await standingAgainst(clone, "upstream", "v2026.11.14")).toEqual({
      kind: "behind",
      current: "v2026.10.30",
      commits: 1,
    });

    // The user's own commit on main does not make them "current", nor does
    // upstream's main moving past the release make them more behind.
    await commit(clone, "mine.txt", "mine");
    await commit(up, "c.txt", "unreleased work");
    expect(await fetchUpstreamStatus(clone)).toMatchObject({
      kind: "behind",
      latest: "v2026.11.14",
    });

    await git(
      clone,
      "merge",
      "-q",
      "--no-edit",
      "refs/release-tags/upstream/v2026.11.14^{commit}",
    );
    expect(await fetchUpstreamStatus(clone)).toMatchObject({
      kind: "current",
      release: "v2026.11.14",
    });
  });

  test("two releases the same day: the later one is the newest", async () => {
    const { up, clone } = await fixture("same-day");
    await release(up, "v2026.11.14");
    await commit(up, "b.txt", "hotfix");
    await release(up, "v2026.11.14.2");
    expect(await fetchUpstreamStatus(clone)).toMatchObject({
      kind: "behind",
      // The day's first release tags the commit the clone was made from.
      current: "v2026.11.14",
      latest: "v2026.11.14.2",
    });
  });

  test("a tag that is no release, or off upstream's main, is ignored", async () => {
    const { up, clone } = await fixture("others");
    await release(up, "v1");
    await git(up, "checkout", "-q", "-b", "side");
    await commit(up, "side.txt", "side");
    await release(up, "v2026.12.01");
    await git(up, "checkout", "-q", "main");
    expect(await fetchUpstreamStatus(clone)).toMatchObject({
      kind: "no-release",
    });
  });

  test("an unreachable upstream is a state, not a crash", async () => {
    const { clone } = await fixture("gone");
    await git(
      clone,
      "remote",
      "set-url",
      "upstream",
      "https://127.0.0.1:9/nothing.git",
    );
    const s = await fetchUpstreamStatus(clone);
    expect(s.kind).toBe("unreachable");
  });
});

describe("upstream's releases are a mirror of their own", () => {
  test("a local tag of the same name neither blocks the fetch nor counts", async () => {
    const { up, clone } = await fixture("collide");
    // The user's own tag, on their own commit, named like upstream's next one.
    await commit(clone, "mine.txt", "mine");
    await release(clone, "v2026.11.14");
    await commit(up, "b.txt", "feature");
    await release(up, "v2026.11.14");
    expect(await fetchUpstreamStatus(clone)).toMatchObject({
      kind: "behind",
      current: null,
      latest: "v2026.11.14",
      ref: "refs/release-tags/upstream/v2026.11.14",
    });
  });

  test("a release upstream retracts stops being offered", async () => {
    const { up, clone } = await fixture("retract");
    await commit(up, "b.txt", "bad");
    await release(up, "v2026.11.14");
    expect((await fetchUpstreamStatus(clone)).kind).toBe("behind");
    await git(up, "tag", "-d", "v2026.11.14");
    expect((await fetchUpstreamStatus(clone)).kind).toBe("no-release");
  });

  test("a stored release no longer on disk is said in words", async () => {
    const { clone } = await fixture("missing");
    expect(standingAgainst(clone, "upstream", "v2030.01.01")).rejects.toThrow(
      "is not on disk",
    );
  });
});

describe("the publisher's own releases", () => {
  test("unreleased commits count from the newest release on main", async () => {
    const { up } = await fixture("own");
    await commit(up, "b.txt", "two");
    expect(await readOwnReleases(up)).toEqual({ latest: null, unreleased: 2 });

    await release(up, "v2026.11.17");
    const head = (await git(up, "rev-parse", "HEAD")).trim();
    const cut = await readOwnReleases(up);
    expect(cut).toMatchObject({
      latest: { tag: "v2026.11.17" },
      unreleased: 0,
    });
    expect(Number.isNaN(Date.parse(cut.latest?.taggedAt ?? ""))).toBe(false);
    expect(await releasesHolding(up, head)).toEqual(["v2026.11.17"]);

    await commit(up, "c.txt", "three");
    await commit(up, "d.txt", "four");
    expect(await readOwnReleases(up)).toMatchObject({
      latest: { tag: "v2026.11.17" },
      unreleased: 2,
    });
    const newer = (await git(up, "rev-parse", "HEAD")).trim();
    expect(await releasesHolding(up, newer)).toEqual([]);
  });
});
