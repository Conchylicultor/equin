import { describe, expect, test } from "bun:test";
import type { Hold } from "@plugins/infra/plugins/deps/plugins/updates/core";
import {
  addLockedTool,
  compareVersions,
  lockProblems,
  parseMiseLock,
  parseMiseToolRequests,
  setLockedVersion,
  upgradeTarget,
} from "./versions";

const LOCK = `# @generated

[[tools.bun]]
version = "1.4.2"
backend = "core:bun"

[tools.bun."platforms.macos-arm64"]
checksum = "sha256:aa"
url = "https://example.invalid/bun-1.4.2.zip"

[[tools.go]]
version = "1.24.13"
backend = "core:go"

[tools.go."platforms.macos-arm64"]
checksum = "sha256:bb"
`;

describe("compareVersions", () => {
  test("orders numerically, not lexically", () => {
    expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
  });
  test("a floor prefix equals its .0 release", () => {
    expect(compareVersions("1.24", "1.24.0")).toBe(0);
    expect(compareVersions("1.24.13", "1.24")).toBeGreaterThan(0);
    expect(compareVersions("1.22.12", "1.24")).toBeLessThan(0);
  });
  test("letter suffixes sort after the bare release", () => {
    expect(compareVersions("3.6a", "3.6")).toBeGreaterThan(0);
    expect(compareVersions("3.7c", "3.7b")).toBeGreaterThan(0);
    expect(compareVersions("3.6a", "3.7")).toBeLessThan(0);
  });
});

describe("parseMiseLock", () => {
  test("reads each tool's version and ignores the platform subtables", () => {
    expect(parseMiseLock(LOCK)).toEqual(
      new Map([
        ["bun", ["1.4.2"]],
        ["go", ["1.24.13"]],
      ]),
    );
  });
});

describe("setLockedVersion", () => {
  test("moves the version and drops only that tool's platform entries", () => {
    const next = setLockedVersion(LOCK, "bun", "1.4.3");
    expect(parseMiseLock(next).get("bun")).toEqual(["1.4.3"]);
    expect(next).not.toContain("bun-1.4.2.zip");
    expect(next).toContain('[tools.go."platforms.macos-arm64"]');
    expect(parseMiseLock(next).get("go")).toEqual(["1.24.13"]);
  });
  test("a tool the lock does not record is an error, not a no-op", () => {
    expect(() => setLockedVersion(LOCK, "tmux", "3.7c")).toThrow();
  });
});

describe("parseMiseToolRequests", () => {
  test("reads only the [tools] table", () => {
    const toml = `[settings]\nbun = "nope"\n\n[tools]\nbun = "latest"\ngo = "latest"  # why\n\n[tasks.x]\ngo = "1.0"\n`;
    expect(parseMiseToolRequests(toml)).toEqual(
      new Map([
        ["bun", "latest"],
        ["go", "latest"],
      ]),
    );
  });
});

const TODAY = "2026-10-17";
const NO_HOLDS = { holds: [], today: TODAY };
const bunHold = (reviewBy: string): Hold => ({
  names: ["bun"],
  version: "1.4.2",
  reason: "broken",
  reviewBy,
});

describe("lockProblems", () => {
  const all = (request: string) =>
    new Map(["bun", "go", "tmux", "rust", "uv"].map((t) => [t, request]));
  const locked = new Map([
    ["bun", ["1.4.2"]],
    ["go", ["1.24.13"]],
    ["tmux", ["3.7c"]],
    ["rust", ["1.98.1"]],
    ["uv", ["0.12.19"]],
  ]);

  test("a sound pair has no problems", () => {
    expect(lockProblems(all("latest"), locked, NO_HOLDS)).toEqual([]);
  });
  test("a pin in mise.toml is a problem", () => {
    const requests = all("latest");
    requests.set("go", "1.24");
    expect(lockProblems(requests, locked, NO_HOLDS).join("\n")).toContain(
      'go "1.24"',
    );
  });
  test("a locked version below its floor is a problem", () => {
    const below = new Map(locked);
    below.set("bun", ["1.3.13"]);
    expect(lockProblems(all("latest"), below, NO_HOLDS).join("\n")).toContain(
      "below its floor 1.4.0",
    );
  });
  test("a missing, doubled or non-exact lock entry is a problem", () => {
    const bad = new Map(locked);
    bad.delete("tmux");
    bad.set("go", ["1.24.13", "1.27.1"]);
    bad.set("rust", ["stable"]);
    expect(lockProblems(all("latest"), bad, NO_HOLDS)).toHaveLength(3);
  });
  test("a newly declared tool may be unlocked only when the caller allows it", () => {
    const fresh = new Map(locked);
    fresh.delete("uv");
    expect(lockProblems(all("latest"), fresh, NO_HOLDS).join("\n")).toContain(
      "mise.lock records no version for uv",
    );
    expect(
      lockProblems(all("latest"), fresh, {
        ...NO_HOLDS,
        unlockedAllowed: new Set(["uv"]),
      }),
    ).toEqual([]);
  });
  test("a declared tool the plugin does not list is a problem", () => {
    const requests = all("latest");
    requests.set("node", "latest");
    const withNode = new Map(locked);
    withNode.set("node", ["22.1.0"]);
    expect(lockProblems(requests, withNode, NO_HOLDS).join("\n")).toContain(
      '"node", which plugins/toolchain/core does not list',
    );
  });

  test("a locked release under a hold is a problem, lapsed or not", () => {
    for (const reviewBy of ["2026-11-01", "2026-10-16"])
      expect(
        lockProblems(all("latest"), locked, {
          holds: [bunHold(reviewBy)],
          today: TODAY,
        }).join("\n"),
      ).toContain(`bun 1.4.2, which is held (review by ${reviewBy}): broken`);
  });
  test("a hold set past 90 days is a problem", () => {
    expect(
      lockProblems(all("latest"), locked, {
        holds: [bunHold("2027-06-01")],
        today: TODAY,
      }).join("\n"),
    ).toContain("a hold goes at most 90 days unreviewed");
  });
});

describe("addLockedTool", () => {
  test("appends a first entry that parses back, and refuses a second", () => {
    const text = '[[tools.bun]]\nversion = "1.4.2"\nbackend = "core:bun"\n';
    const added = addLockedTool(text, "uv", "0.12.19", "aqua:astral-sh/uv");
    expect(added).toContain('backend = "aqua:astral-sh/uv"');
    expect(parseMiseLock(added).get("uv")).toEqual(["0.12.19"]);
    expect(parseMiseLock(added).get("bun")).toEqual(["1.4.2"]);
    expect(() => addLockedTool(added, "uv", "0.12.20", "x")).toThrow(
      "already has",
    );
  });
});

describe("upgradeTarget", () => {
  test("takes the newest exact release, ignoring channels and prereleases", () => {
    expect(
      upgradeTarget("bun", ["1.4.1", "1.4.2", "1.5.0-canary.1", "canary"], []),
    ).toBe("1.4.2");
  });
  test("skips a held release, lapsed or not", () => {
    const available = ["1.4.1", "1.4.2"];
    for (const reviewBy of ["2026-11-01", "2026-10-16"])
      expect(upgradeTarget("bun", available, [bunHold(reviewBy)])).toBe(
        "1.4.1",
      );
  });
  test("nothing to take is null", () => {
    expect(upgradeTarget("bun", ["canary"], [])).toBeNull();
  });
});
