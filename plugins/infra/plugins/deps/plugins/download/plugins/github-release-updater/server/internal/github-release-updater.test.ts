import { describe, expect, test } from "bun:test";
import type { GithubReleasePin } from "@plugins/infra/plugins/deps/plugins/download/deps";
import {
  compareReleaseTags,
  movedPin,
  releaseRow,
  type Release,
} from "./github-release-updater";

const pin: GithubReleasePin = {
  repo: "uBlockOrigin/uBOL-home",
  asset: "uBOLite_{tag}.chromium.zip",
  tag: "2026.1026.1812",
  publishedAt: "2026-10-26T18:13:42.000Z",
  sha256: "a".repeat(64),
};

const release = (
  tag: string,
  publishedAt: string,
  digest: string | null = "b".repeat(64),
): Release => ({
  tag,
  publishedAt,
  assets: new Map([[`uBOLite_${tag}.chromium.zip`, digest]]),
});

const releases = [
  release("2026.1110.1816", "2026-11-10T18:18:16.000Z"),
  release("2026.1103.1743", "2026-11-03T17:44:40.000Z"),
  pinRelease(),
];
function pinRelease(): Release {
  return release(pin.tag, pin.publishedAt, pin.sha256);
}

describe("releaseRow", () => {
  test("moves to the newest release past the cooldown", () => {
    const row = releaseRow({
      depId: "blocker-rulesets",
      pin,
      releases,
      now: new Date("2026-11-15T12:00:00Z"),
      cooldown: "honour",
      holds: [],
    });
    expect(row).toEqual({
      name: "blocker-rulesets",
      current: pin.tag,
      latest: "2026.1110.1816",
    });
  });

  test("a release inside the cooldown waits, with when", () => {
    const row = releaseRow({
      depId: "blocker-rulesets",
      pin,
      releases,
      now: new Date("2026-11-12T12:00:00Z"),
      cooldown: "honour",
      holds: [],
    });
    expect(row?.latest).toBe("2026.1103.1743");
    const waiting = releaseRow({
      depId: "blocker-rulesets",
      pin: {
        ...pin,
        tag: "2026.1103.1743",
        publishedAt: "2026-11-03T17:44:40.000Z",
      },
      releases,
      now: new Date("2026-11-12T12:00:00Z"),
      cooldown: "honour",
      holds: [],
    });
    expect(waiting?.waiting).toEqual({
      kind: "awaiting",
      on: {
        kind: "cooldown",
        of: ["blocker-rulesets"],
        until: "2026-11-14T00:00:00.000Z",
      },
    });
  });

  test("a held release is listed as held, never dropped", () => {
    const row = releaseRow({
      depId: "blocker-rulesets",
      pin,
      releases,
      now: new Date("2026-11-15T12:00:00Z"),
      cooldown: "honour",
      holds: [
        {
          names: ["blocker-rulesets"],
          below: "2026.1103.0",
          reason: "broken",
          reviewBy: "2026-12-01",
        },
      ],
    });
    expect(row?.latest).toBe("2026.1110.1816");
    expect(row?.waiting?.kind).toBe("held");
  });

  test("on its newest release: no row", () => {
    expect(
      releaseRow({
        depId: "x",
        pin: {
          ...pin,
          tag: "2026.1110.1816",
          publishedAt: "2026-11-10T18:18:16.000Z",
        },
        releases,
        now: new Date("2026-11-20T00:00:00Z"),
        cooldown: "honour",
        holds: [],
      }),
    ).toBeNull();
  });
});

describe("movedPin", () => {
  test("takes the release's tag, instant and digest", () => {
    expect(movedPin(pin, releases[0]!)).toEqual({
      ...pin,
      tag: "2026.1110.1816",
      publishedAt: "2026-11-10T18:18:16.000Z",
      sha256: "b".repeat(64),
    });
  });

  test("refuses a release GitHub reports no digest for", () => {
    expect(() =>
      movedPin(pin, release("2026.1201.1", "2026-12-01T00:00:00.000Z", null)),
    ).toThrow(/no sha256 digest/);
  });
});

test("compareReleaseTags orders dotted numbers", () => {
  expect(
    compareReleaseTags("2026.1110.1816", "2026.1103.1743"),
  ).toBeGreaterThan(0);
  expect(compareReleaseTags("v1.2", "1.10")).toBeLessThan(0);
});
