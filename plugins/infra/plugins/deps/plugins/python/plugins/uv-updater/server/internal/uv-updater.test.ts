import { describe, expect, test } from "bun:test";
import type { Hold } from "@plugins/infra/plugins/deps/plugins/updates/core";
import {
  isNewerRelease,
  newestCpython,
  parseCpythonDownloads,
  parseLockUpdates,
  parseUvLockVersions,
  uvCutoff,
} from "./uv-updater";

describe("uv updater parsing", () => {
  test("reads the Update lines of a uv lock run", () => {
    const output = [
      "Using CPython 3.12.14",
      "Resolved 2 packages in 425ms",
      "Update numpy v2.5.3 -> v2.5.4",
      "Update certifi v2026.8.1 -> v2026.9.2",
    ].join("\n");
    expect(parseLockUpdates(output)).toEqual([
      { pkg: "numpy", from: "2.5.3", to: "2.5.4" },
      { pkg: "certifi", from: "2026.8.1", to: "2026.9.2" },
    ]);
    expect(parseLockUpdates("Lockfile changes detected\n")).toEqual([]);
  });

  test("reads package versions out of a uv.lock", () => {
    const lock = `version = 1
requires-python = ">=3.12"

[options]
exclude-newer = "2026-09-26T00:00:00Z"

[[package]]
name = "singularity-audio"
version = "0.0.0"
source = { virtual = "." }

[[package]]
name = "numpy"
version = "2.5.3"
source = { registry = "https://pypi.org/simple" }
`;
    const versions = parseUvLockVersions(lock);
    expect(versions.get("numpy")).toBe("2.5.3");
    expect(versions.get("singularity-audio")).toBe("0.0.0");
    expect(versions.has("exclude-newer")).toBe(false);
  });

  test("the cooldown cutoff is the start of the UTC day, three days back", () => {
    expect(uvCutoff(new Date("2026-09-29T17:46:09Z"))).toBe(
      "2026-09-26T00:00:00.000Z",
    );
    expect(uvCutoff(new Date("2026-09-29T00:00:01Z"))).toBe(
      "2026-09-26T00:00:00.000Z",
    );
  });

  test("a downgrade proposed under an older cutoff is not an upgrade", () => {
    expect(isNewerRelease("2.5.4", "2.5.3")).toBe(true);
    expect(isNewerRelease("2.5.0", "2.5.3")).toBe(false);
    expect(isNewerRelease("2026.9.2", "2026.8.1")).toBe(true);
    expect(isNewerRelease("1.0", "1.0.0")).toBe(false);
  });
});

describe("uv updater interpreter", () => {
  const entry = (version: string, day: string, extra: object = {}) => ({
    key: `cpython-${version}-macos-aarch64-none`,
    version,
    implementation: "cpython",
    variant: "default",
    url: `https://releases.astral.sh/github/python-build-standalone/releases/download/${day}/cpython-${version}%2B${day}-aarch64-apple-darwin-install_only_stripped.tar.gz`,
    ...extra,
  });

  test("keeps stable default CPython builds with their publish day", () => {
    const json = JSON.stringify([
      entry("3.15.0rc2", "20260924"),
      entry("3.14.7", "20260924", { variant: "freethreaded" }),
      entry("3.14.7", "20260924"),
      entry("3.14.6", "20260804"),
      entry("7.3.20", "20260804", { implementation: "pypy" }),
      { ...entry("3.13.15", "20260924"), url: null },
    ]);
    expect(parseCpythonDownloads(json)).toEqual([
      { version: "3.14.7", published: "2026-09-24" },
      { version: "3.14.6", published: "2026-08-04" },
    ]);
  });

  test("a download URL without a release day fails loudly", () => {
    const json = JSON.stringify([
      { ...entry("3.14.7", "20260924"), url: "https://example.com/py.tgz" },
    ]);
    expect(() => parseCpythonDownloads(json)).toThrow(/no release day/);
  });

  test("picks the newest release past the cooldown, across minors", () => {
    const downloads = [
      { version: "3.12.14", published: "2026-09-24" },
      { version: "3.14.6", published: "2026-08-04" },
      { version: "3.14.7", published: "2026-09-24" },
      { version: "3.13.15", published: "2026-09-24" },
    ];
    expect("3.14.7").toBe("3.14.7");
    // 3.14.7 is inside the cooldown: fall back to the newest one outside it.
    expect(newestCpython(downloads, "2026-09-23T00:00:00.000Z", [])).toBe(
      "3.14.6",
    );
    expect(newestCpython(downloads, "2026-01-01T00:00:00.000Z", [])).toBeNull();
  });

  test("skips a held release, lapsed or not", () => {
    const downloads = [
      { version: "3.14.7", published: "2026-09-24" },
      { version: "3.15.0", published: "2026-09-24" },
    ];
    const hold = (reviewBy: string): Hold => ({
      names: ["cpython"],
      version: "3.15.0",
      reason: "no wheels",
      reviewBy,
    });
    const cutoff = "2026-09-27T00:00:00.000Z";
    for (const reviewBy of ["2026-11-01", "2026-10-16"])
      expect(newestCpython(downloads, cutoff, [hold(reviewBy)])).toBe("3.14.7");
  });

  test("an exact pin is older than a newer patch, and a loose one is too", () => {
    expect(isNewerRelease("3.14.7", "3.12")).toBe(true);
    expect(isNewerRelease("3.12.14", "3.12")).toBe(true);
    expect(isNewerRelease("3.14.7", "3.14.7")).toBe(false);
  });
});
