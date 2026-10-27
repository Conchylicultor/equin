import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { WORKTREE_SPEC_FILE } from "@plugins/infra/plugins/paths/core";
import {
  distNames,
  distStagingPath,
  publishDistAtomic,
  sweepDistLeftovers,
} from "./dist-publish";

const tmp = mkdtempSync(join(tmpdir(), "dist-publish-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("distNames (path arithmetic)", () => {
  test("derives sibling names from the live dir's basename", () => {
    const names = distNames("/x/web-core/web/dist", 42);
    expect(names).toEqual({
      parent: "/x/web-core/web",
      base: "dist",
      stagingPath: "/x/web-core/web/dist.staging.42",
      releaseName: "dist.live.42",
      releasePath: "/x/web-core/web/dist.live.42",
      swapPath: "/x/web-core/web/dist.swap.42",
      prefixes: {
        staging: "dist.staging.",
        live: "dist.live.",
        swap: "dist.swap.",
        old: "dist.old.",
      },
    });
  });

  test("a composition's web dir gets its own prefix family", () => {
    const names = distNames("/home/u/.equin/worktrees/sonata/web", 7);
    expect(names.parent).toBe("/home/u/.equin/worktrees/sonata");
    expect(names.releaseName).toBe("web.live.7");
    expect(distStagingPath("/home/u/.equin/worktrees/sonata/web", 7)).toBe(
      "/home/u/.equin/worktrees/sonata/web.staging.7",
    );
  });
});

describe("publishDistAtomic", () => {
  test("first publish: live symlink points at a complete release", async () => {
    const dir = join(tmp, "first", "web");
    const stagingPath = distStagingPath(dir);
    mkdirSync(stagingPath, { recursive: true });
    writeFileSync(join(stagingPath, "index.html"), "v1");

    await publishDistAtomic({ dir, stagingPath });

    expect(lstatSync(dir).isSymbolicLink()).toBe(true);
    expect(readlinkSync(dir)).toBe(`web.live.${process.pid}`);
    expect(readFileSync(join(dir, "index.html"), "utf8")).toBe("v1");
    expect(existsSync(stagingPath)).toBe(false);
  });

  test("republish: repoints the symlink and reclaims the previous release", async () => {
    const parent = join(tmp, "repub");
    const dir = join(parent, "dist");
    mkdirSync(join(parent, "dist.live.999"), { recursive: true });
    writeFileSync(join(parent, "dist.live.999", "index.html"), "old");
    symlinkSync("dist.live.999", dir);

    const stagingPath = distStagingPath(dir);
    mkdirSync(stagingPath, { recursive: true });
    writeFileSync(join(stagingPath, "index.html"), "new");
    await publishDistAtomic({ dir, stagingPath });

    expect(readlinkSync(dir)).toBe(`dist.live.${process.pid}`);
    expect(readFileSync(join(dir, "index.html"), "utf8")).toBe("new");
    expect(existsSync(join(parent, "dist.live.999"))).toBe(false);
  });

  test("legacy real-directory dist is replaced by the symlink scheme", async () => {
    const parent = join(tmp, "legacy");
    const dir = join(parent, "dist");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), "legacy");

    const stagingPath = distStagingPath(dir);
    mkdirSync(stagingPath, { recursive: true });
    writeFileSync(join(stagingPath, "index.html"), "new");
    await publishDistAtomic({ dir, stagingPath });

    expect(lstatSync(dir).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(dir, "index.html"), "utf8")).toBe("new");
  });
});

describe("sweepDistLeftovers", () => {
  test("no-op when nothing was ever published there", async () => {
    await sweepDistLeftovers(join(tmp, "never", "web"));
    expect(existsSync(join(tmp, "never"))).toBe(false);
  });

  test("restores the newest surviving release and reclaims every other leftover", async () => {
    const parent = join(tmp, "sweep");
    const dir = join(parent, "web");
    for (const name of [
      "web.live.100",
      "web.live.200",
      "web.staging.300",
      "web.swap.400",
      "web.old.500",
    ]) {
      mkdirSync(join(parent, name), { recursive: true });
      writeFileSync(join(parent, name, "index.html"), name);
    }
    // The real non-prefixed sibling in a worktree data dir: its spec.
    writeFileSync(join(parent, WORKTREE_SPEC_FILE), "{}");

    await sweepDistLeftovers(dir);

    expect(readlinkSync(dir)).toBe("web.live.200");
    expect(readFileSync(join(dir, "index.html"), "utf8")).toBe("web.live.200");
    for (const gone of [
      "web.live.100",
      "web.staging.300",
      "web.swap.400",
      "web.old.500",
    ]) {
      expect(existsSync(join(parent, gone))).toBe(false);
    }
    expect(existsSync(join(parent, WORKTREE_SPEC_FILE))).toBe(true);
  });

  test("keeps the healthy current release, drops a dangling symlink's leftovers", async () => {
    const parent = join(tmp, "sweep2");
    const dir = join(parent, "dist");
    mkdirSync(join(parent, "dist.live.1"), { recursive: true });
    writeFileSync(join(parent, "dist.live.1", "index.html"), "live");
    mkdirSync(join(parent, "dist.staging.2"), { recursive: true });
    symlinkSync("dist.live.1", dir);

    await sweepDistLeftovers(dir);

    expect(readlinkSync(dir)).toBe("dist.live.1");
    expect(existsSync(join(parent, "dist.staging.2"))).toBe(false);
  });
});
