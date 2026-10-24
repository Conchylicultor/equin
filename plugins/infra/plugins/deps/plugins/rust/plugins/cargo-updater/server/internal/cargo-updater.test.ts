import { describe, expect, test } from "bun:test";
import type { Hold } from "@plugins/infra/plugins/deps/plugins/updates/core";
import {
  cargoCutoff,
  compareCrateVersions,
  moveCrate,
  parseCargoLock,
  parseCargoUpdates,
  pickRelease,
  type CrateRelease,
} from "./cargo-updater";

describe("cargo updater parsing", () => {
  test("reads the Updating lines of a cargo update --dry-run", () => {
    const output = [
      "    Updating crates.io index",
      "     Locking 2 packages to latest compatible versions",
      "    Updating serde v1.0.200 -> v1.0.210",
      "    Updating libc v0.2.150 -> v0.2.160 (available: v0.3.0)",
      "      Adding windows-sys v0.59.0",
      "warning: aborting update due to dry run",
    ].join("\n");
    expect(parseCargoUpdates(output)).toEqual([
      { pkg: "serde", from: "1.0.200", to: "1.0.210" },
      { pkg: "libc", from: "0.2.150", to: "0.2.160" },
    ]);
  });

  test("reads every package of a Cargo.lock with its source", () => {
    const lock = `version = 4

[[package]]
name = "hello"
version = "0.1.0"
dependencies = ["serde"]

[[package]]
name = "serde"
version = "1.0.200"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "abc"
`;
    expect(parseCargoLock(lock)).toEqual([
      { name: "hello", version: "0.1.0", source: undefined },
      {
        name: "serde",
        version: "1.0.200",
        source: "registry+https://github.com/rust-lang/crates.io-index",
      },
    ]);
  });

  test("a move's name carries its crate", () => {
    expect(moveCrate("menu-bar:serde")).toBe("serde");
    expect(moveCrate("menu-bar:windows-sys@0.52.0")).toBe("windows-sys");
  });
});

describe("cargo updater choice", () => {
  const cutoff = cargoCutoff(new Date("2026-10-24T15:00:00Z"));
  const rel = (num: string, day: string, yanked = false): CrateRelease => ({
    num,
    createdAt: `${day}T12:00:00.000Z`,
    yanked,
  });
  const releases = [
    rel("1.0.200", "2026-01-01"),
    rel("1.0.205", "2026-09-01"),
    rel("1.0.206", "2026-10-01", true),
    rel("1.0.207-rc.1", "2026-10-02"),
    rel("1.0.208", "2026-10-20"),
    rel("1.0.209", "2026-10-23"),
    rel("2.0.0", "2026-08-01"),
  ];

  test("the cooldown is three whole days", () => {
    expect(cutoff).toBe("2026-10-21T00:00:00.000Z");
  });

  test("the newest release past the cooldown, in range, neither yanked nor a pre-release", () => {
    expect(
      pickRelease(releases, "serde", "1.0.200", "1.0.209", cutoff, []),
    ).toBe("1.0.208");
    // Nothing above the ceiling cargo reports (2.0.0 is outside the requirement).
    expect(
      pickRelease(releases, "serde", "1.0.200", "1.0.205", cutoff, []),
    ).toBe("1.0.205");
    expect(
      pickRelease(releases, "serde", "1.0.208", "1.0.209", cutoff, []),
    ).toBe(null);
  });

  test("a held release is skipped", () => {
    const holds: Hold[] = [
      {
        names: ["serde"],
        version: "1.0.208",
        reason: "r",
        reviewBy: "2026-12-01",
      },
    ];
    expect(
      pickRelease(releases, "serde", "1.0.200", "1.0.209", cutoff, holds),
    ).toBe("1.0.205");
  });

  test("versions order by their numbers", () => {
    expect(compareCrateVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareCrateVersions("1.0.0", "1.0.0")).toBe(0);
  });
});
