import { describe, expect, test } from "bun:test";
import { environmentNotes, versionLine } from "./notes";

const SHA = "bf902af7e2a1c3d4e5f60718293a4b5c6d7e8f90";
const at = (ahead: number, behind: number) =>
  versionLine({
    kind: "commit",
    commit: SHA,
    release: "v2026.11.17.2",
    base: "upstream/main",
    ahead,
    behind,
  });

describe("versionLine", () => {
  test("names the release, the short commit and where it stands", () => {
    expect(at(0, 0)).toBe("2026.11.17.2 · bf902af7e2 · at upstream/main");
    expect(at(3, 0)).toBe(
      "2026.11.17.2 · bf902af7e2 · 3 commits ahead of upstream/main",
    );
    expect(at(0, 1)).toBe(
      "2026.11.17.2 · bf902af7e2 · 1 commit behind upstream/main",
    );
    expect(at(1, 12)).toBe(
      "2026.11.17.2 · bf902af7e2 · 1 commit ahead of upstream/main, 12 behind",
    );
  });

  test("says when the commit holds no release", () => {
    expect(
      versionLine({
        kind: "commit",
        commit: SHA,
        release: null,
        base: "main",
        ahead: 0,
        behind: 0,
      }),
    ).toBe("no release · bf902af7e2 · at main");
  });

  test("gives the reason when the backend cannot name its commit", () => {
    expect(versionLine({ kind: "unknown", reason: "mixed boot" })).toBe(
      "unknown commit (mixed boot)",
    );
  });
});

describe("environmentNotes", () => {
  test("version, system and browser, one line each", () => {
    expect(
      environmentNotes(
        {
          kind: "ready",
          environment: {
            system: "macOS 26.4 (arm64)",
            runtime: "Bun 1.3.2",
            code: {
              kind: "commit",
              commit: SHA,
              release: "v2026.11.17.2",
              base: "main",
              ahead: 0,
              behind: 0,
            },
          },
        },
        "Chrome 142 on macOS",
      ),
    ).toEqual([
      "Version: equin 2026.11.17.2 · bf902af7e2 · at main",
      "System: macOS 26.4 (arm64) · Bun 1.3.2",
      "Browser: Chrome 142 on macOS",
    ]);
  });

  test("keeps the browser line when the backend's half is out of reach", () => {
    expect(
      environmentNotes(
        { kind: "unavailable", message: "Needs the computer" },
        "Safari 18.2 on iOS",
      ),
    ).toEqual(["Version: Needs the computer", "Browser: Safari 18.2 on iOS"]);
    expect(
      environmentNotes({ kind: "error", message: "boom" }, "Firefox 133"),
    ).toEqual(["Version: could not be read (boom)", "Browser: Firefox 133"]);
  });
});
