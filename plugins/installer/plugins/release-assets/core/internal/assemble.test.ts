import { describe, expect, test } from "bun:test";
import { INSTALL_PROTOCOL_VERSION } from "@plugins/installer/core";
import { releaseManifest, sha256Sums } from "./assemble";
import { HANDOFF_MARKER, INSTALLER_BINARIES, ReleaseManifest } from "./assets";

const COMMIT = "247f2541cf4f21ebf337fec2022914dff8a6755d";

describe("releaseManifest", () => {
  test("a release with the window: v2, no binaries listed, installers attached separately", () => {
    const m = releaseManifest({
      tag: "v2026.12.01",
      commit: COMMIT,
      script: `set -e\n${HANDOFF_MARKER}\nmain "$@"\n`,
      installers: true,
    });
    expect(m).toEqual({
      v: 2,
      tag: "v2026.12.01",
      commit: COMMIT,
      handoff: 1,
      eventsProtocol: INSTALL_PROTOCOL_VERSION,
      installers: 1,
    });
    // install.sh reads it one key per line, and finds no platform key in it:
    // a v1-only stage 0 installs it in the terminal.
    const text = JSON.stringify(m, null, 2);
    expect(text).toContain('\n  "installers": 1\n');
    for (const p of Object.keys(INSTALLER_BINARIES))
      expect(text).not.toContain(p);
  });

  test("a release cut before the window: no installers, no hand-off", () => {
    const m = releaseManifest({
      tag: "v2026.11.17",
      commit: COMMIT,
      script: "set -e\nmain\n",
      installers: false,
    });
    expect(m.handoff).toBeNull();
    expect(m.eventsProtocol).toBeNull();
    expect(m.installers).toBeNull();
  });

  test("the marker counts only as a whole line", () => {
    const m = releaseManifest({
      tag: "v2026.11.17",
      commit: COMMIT,
      script: `echo "${HANDOFF_MARKER}"\n`,
      installers: false,
    });
    expect(m.handoff).toBeNull();
  });

  test("a commit that is not a full sha is refused", () => {
    expect(() =>
      releaseManifest({
        tag: "v2026.11.17",
        commit: "abc",
        script: "",
        installers: false,
      }),
    ).toThrow();
  });
});

describe("ReleaseManifest", () => {
  test("still reads a v1 manifest (its binaries listed)", () => {
    const v1 = ReleaseManifest.parse({
      v: 1,
      tag: "v2026.11.30",
      commit: COMMIT,
      handoff: 1,
      eventsProtocol: 1,
      assets: { "linux-x64": INSTALLER_BINARIES["linux-x64"] },
    });
    expect(v1.v).toBe(1);
  });

  test("refuses another version, and a v2 manifest listing binaries", () => {
    const base = {
      tag: "v2026.12.01",
      commit: COMMIT,
      handoff: 1,
      eventsProtocol: 1,
    };
    expect(() =>
      ReleaseManifest.parse({ v: 3, ...base, installers: 1 }),
    ).toThrow();
    expect(
      ReleaseManifest.safeParse({ v: 2, ...base, assets: {} }).success,
    ).toBe(false);
  });
});

describe("sha256Sums", () => {
  const a = "a".repeat(64);
  const b = "b".repeat(64);
  test("sha256sum's format, sorted by name", () => {
    expect(
      sha256Sums([
        { name: "release.json", sha256: b },
        { name: "install.sh", sha256: a },
      ]),
    ).toBe(`${a}  install.sh\n${b}  release.json\n`);
  });
  test("refuses a bad hash or a name with a space", () => {
    expect(() => sha256Sums([{ name: "x", sha256: "nope" }])).toThrow();
    expect(() => sha256Sums([{ name: "a b", sha256: a }])).toThrow();
  });
});
