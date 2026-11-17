import { describe, expect, test } from "bun:test";
import { releaseManifest, sha256Sums } from "./assemble";
import { HANDOFF_MARKER } from "./assets";

const COMMIT = "247f2541cf4f21ebf337fec2022914dff8a6755d";

describe("releaseManifest", () => {
  test("a release with the window: its binaries, hand-off and protocol", () => {
    const m = releaseManifest({
      tag: "v2026.12.01",
      commit: COMMIT,
      script: `set -e\n${HANDOFF_MARKER}\nmain "$@"\n`,
      built: ["macos-universal", "linux-x64", "linux-arm64"],
    });
    expect(m).toEqual({
      v: 1,
      tag: "v2026.12.01",
      commit: COMMIT,
      handoff: 1,
      eventsProtocol: 1,
      assets: {
        "macos-universal": "equin-installer-macos-universal",
        "linux-x64": "equin-installer-linux-x64",
        "linux-arm64": "equin-installer-linux-arm64",
      },
    });
  });

  test("a release cut before the window: no binaries, no hand-off", () => {
    const m = releaseManifest({
      tag: "v2026.11.17",
      commit: COMMIT,
      script: "set -e\nmain\n",
      built: [],
    });
    expect(m.handoff).toBeNull();
    expect(m.eventsProtocol).toBeNull();
    expect(m.assets).toEqual({});
  });

  test("the marker counts only as a whole line", () => {
    const m = releaseManifest({
      tag: "v2026.11.17",
      commit: COMMIT,
      script: `echo "${HANDOFF_MARKER}"\n`,
      built: [],
    });
    expect(m.handoff).toBeNull();
  });

  test("a commit that is not a full sha is refused", () => {
    expect(() =>
      releaseManifest({
        tag: "v2026.11.17",
        commit: "abc",
        script: "",
        built: [],
      }),
    ).toThrow();
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
