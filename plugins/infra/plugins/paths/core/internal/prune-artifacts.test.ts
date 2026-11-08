import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import {
  asAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pruneBuildArtifactsInDirSync,
  pruneCheckArtifactsInDirSync,
} from "./prune-artifacts";

const dirs: AppPath[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function seed(files: Array<{ name: string; ageMs: number }>): AppPath {
  const dir = asAppPath(mkdtempSync(join(tmpdir(), "prune-build-artifacts-")));
  dirs.push(dir);
  const now = Date.now();
  for (const f of files) {
    const path = join(dir, f.name);
    writeFileSync(path, "{}");
    const t = (now - f.ageMs) / 1000;
    utimesSync(path, t, t);
  }
  return dir;
}

describe("pruneBuildArtifactsInDir", () => {
  test("keeps the newest N build-id sets and deletes older ones", () => {
    const files: Array<{ name: string; ageMs: number }> = [];
    for (let i = 0; i < 5; i++) {
      const id = `c${i}-${1000 + i}`;
      const ageMs = (5 - i) * 60_000; // i=0 oldest, i=4 newest
      files.push({ name: `build-profile-${id}.json`, ageMs });
      files.push({ name: `build-logs-${id}.json`, ageMs });
      files.push({ name: `build-${id}.log`, ageMs });
    }
    const dir = seed(files);

    pruneBuildArtifactsInDirSync(dir, 2);

    const remaining = new Set(readdirSync(dir));
    for (const i of [3, 4]) {
      const id = `c${i}-${1000 + i}`;
      expect(remaining.has(`build-profile-${id}.json`)).toBe(true);
      expect(remaining.has(`build-logs-${id}.json`)).toBe(true);
      expect(remaining.has(`build-${id}.log`)).toBe(true);
    }
    for (const i of [0, 1, 2]) {
      const id = `c${i}-${1000 + i}`;
      expect(remaining.has(`build-profile-${id}.json`)).toBe(false);
      expect(remaining.has(`build-logs-${id}.json`)).toBe(false);
      expect(remaining.has(`build-${id}.log`)).toBe(false);
    }
    expect(remaining.size).toBe(6);
  });

  test("never prunes the un-suffixed latest aliases", () => {
    const dir = seed([
      { name: "build-profile.json", ageMs: 10_000_000 },
      { name: "build-logs.json", ageMs: 10_000_000 },
      { name: "build.log", ageMs: 10_000_000 },
      { name: "build-profile-old-1.json", ageMs: 5_000 },
      { name: "build-logs-old-1.json", ageMs: 5_000 },
      { name: "build-old-1.log", ageMs: 5_000 },
    ]);

    pruneBuildArtifactsInDirSync(dir, 0); // keep zero id-keyed sets

    const remaining = new Set(readdirSync(dir));
    expect(remaining.has("build-profile.json")).toBe(true);
    expect(remaining.has("build-logs.json")).toBe(true);
    expect(remaining.has("build.log")).toBe(true);
    expect(remaining.has("build-profile-old-1.json")).toBe(false);
    expect(remaining.has("build-logs-old-1.json")).toBe(false);
    expect(remaining.has("build-old-1.log")).toBe(false);
  });

  test("sweeps crashed-write .tmp leftovers regardless of retention", () => {
    const dir = seed([
      { name: "build-profile-c9-9.json", ageMs: 1_000 },
      { name: "build-logs-c9-9.json.tmp.12345", ageMs: 2_000 },
      { name: "build-profile.json.tmp.999", ageMs: 3_000 },
    ]);

    pruneBuildArtifactsInDirSync(dir, 50);

    const remaining = new Set(readdirSync(dir));
    expect(remaining.has("build-profile-c9-9.json")).toBe(true);
    expect(remaining.has("build-logs-c9-9.json.tmp.12345")).toBe(false);
    expect(remaining.has("build-profile.json.tmp.999")).toBe(false);
  });

  test("leaves unrelated per-worktree files untouched", () => {
    const dir = seed([
      { name: "spec.json", ageMs: 1_000 },
      { name: "check.log", ageMs: 1_000 },
      { name: "build-profile-c1-1.json", ageMs: 2_000 },
    ]);

    pruneBuildArtifactsInDirSync(dir, 0);

    const remaining = new Set(readdirSync(dir));
    expect(remaining.has("spec.json")).toBe(true);
    expect(remaining.has("check.log")).toBe(true);
    expect(remaining.has("build-profile-c1-1.json")).toBe(false);
  });

  test("no-ops on a missing dir", () => {
    expect(() =>
      pruneBuildArtifactsInDirSync(
        asAppPath(join(tmpdir(), "nope-xyz-123")),
        5,
      ),
    ).not.toThrow();
  });

  // The one pair that shares a suffix: both families end in `.log`, so only the
  // prefix keeps them apart. A build's prune must not reap that build's own
  // check transcript — the build log's `Check logs:` pointer names it.
  test("never touches check-family files", () => {
    const dir = seed([
      { name: "check-c1-1.log", ageMs: 10_000 },
      { name: "check-c1-1.log.tmp.777", ageMs: 10_000 },
      { name: "build-c1-1.log", ageMs: 1_000 },
    ]);

    pruneBuildArtifactsInDirSync(dir, 0);

    const remaining = new Set(readdirSync(dir));
    expect(remaining.has("check-c1-1.log")).toBe(true);
    expect(remaining.has("check-c1-1.log.tmp.777")).toBe(true);
    expect(remaining.has("build-c1-1.log")).toBe(false);
  });
});

describe("pruneCheckArtifactsInDir", () => {
  test("keeps the newest N check transcripts and deletes older ones", () => {
    const files: Array<{ name: string; ageMs: number }> = [];
    for (let i = 0; i < 5; i++) {
      const ageMs = (5 - i) * 60_000; // i=0 oldest, i=4 newest
      files.push({ name: `check-c${i}-${1000 + i}.log`, ageMs });
    }
    const dir = seed(files);

    pruneCheckArtifactsInDirSync(dir, 2);

    const remaining = new Set(readdirSync(dir));
    for (const i of [3, 4]) {
      expect(remaining.has(`check-c${i}-${1000 + i}.log`)).toBe(true);
    }
    for (const i of [0, 1, 2]) {
      expect(remaining.has(`check-c${i}-${1000 + i}.log`)).toBe(false);
    }
    expect(remaining.size).toBe(2);
  });

  test("sweeps crashed-write .tmp leftovers regardless of retention", () => {
    const dir = seed([
      { name: "check-c9-9.log", ageMs: 1_000 },
      { name: "check-c8-8.log.tmp.12345", ageMs: 2_000 },
    ]);

    pruneCheckArtifactsInDirSync(dir, 50);

    const remaining = new Set(readdirSync(dir));
    expect(remaining.has("check-c9-9.log")).toBe(true);
    expect(remaining.has("check-c8-8.log.tmp.12345")).toBe(false);
  });

  test("reaps the legacy fixed-path check.log", () => {
    const dir = seed([
      { name: "check.log", ageMs: 1_000 },
      { name: "check-c1-1.log", ageMs: 1_000 },
    ]);

    pruneCheckArtifactsInDirSync(dir, 50);

    const remaining = new Set(readdirSync(dir));
    expect(remaining.has("check.log")).toBe(false);
    expect(remaining.has("check-c1-1.log")).toBe(true);
  });

  test("never touches build-family files", () => {
    const dir = seed([
      { name: "build-profile-c1-1.json", ageMs: 10_000 },
      { name: "build-logs-c1-1.json", ageMs: 10_000 },
      { name: "build-c1-1.log", ageMs: 10_000 },
      { name: "build.log", ageMs: 10_000 },
      { name: "check-c1-1.log", ageMs: 1_000 },
    ]);

    pruneCheckArtifactsInDirSync(dir, 0);

    const remaining = new Set(readdirSync(dir));
    expect(remaining.has("build-profile-c1-1.json")).toBe(true);
    expect(remaining.has("build-logs-c1-1.json")).toBe(true);
    expect(remaining.has("build-c1-1.log")).toBe(true);
    expect(remaining.has("build.log")).toBe(true);
    expect(remaining.has("check-c1-1.log")).toBe(false);
  });

  test("no-ops on a missing dir", () => {
    expect(() =>
      pruneCheckArtifactsInDirSync(
        asAppPath(join(tmpdir(), "nope-xyz-789")),
        5,
      ),
    ).not.toThrow();
  });
});
