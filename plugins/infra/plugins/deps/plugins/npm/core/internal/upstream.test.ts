import { describe, expect, test } from "bun:test";
import type { Packument } from "./plan";
import type { Group } from "./policy";
import type { Hold } from "@plugins/infra/plugins/deps/plugins/updates/core";
import {
  newestTag,
  patternProblem,
  tagVersions,
  upstreamRows,
} from "./upstream";

const AT = "2026-10-01T00:00:00.000Z";
const TAGGED = "2026-10-02T12:00:00.000Z";

function pkg(...versions: string[]): Packument {
  return {
    latest: versions.at(-1)!,
    published: new Map(versions.map((v) => [v, AT])),
  };
}

const group: Group = {
  id: "pg-client",
  members: ["@x/pg-a", "@x/pg-b"],
  agree: "version",
  reason: "one build per platform",
  wraps: {
    name: "PostgreSQL",
    tags: { repo: "https://example.com/pg", pattern: "^REL_(\\d+)_(\\d+)$" },
    agree: "major.minor",
    prerequisite: "publish the client for <version>",
  },
};

function rows(published: string[], release: string, holds: Hold[] = []) {
  return upstreamRows({
    groups: [group],
    packuments: new Map(group.members.map((m) => [m, pkg(...published)])),
    installed: new Map([["@x/pg-a", "18.3.0"]]),
    upstream: new Map([[group.id, { release, taggedAt: TAGGED }]]),
    holds,
    today: "2026-10-16",
  });
}

describe("tagVersions", () => {
  test("captures pad to major.minor.patch; prerelease tags do not match", () => {
    expect(
      tagVersions(
        ["REL_18_6", "REL_19_BETA1", "REL_19_RC1", "REL_9_6", "other"],
        "^REL_(\\d+)_(\\d+)$",
      ),
    ).toEqual(["18.6.0", "9.6.0"]);
    expect(
      tagVersions(["pgbouncer_1_26_1"], "^pgbouncer_(\\d+)_(\\d+)_(\\d+)$"),
    ).toEqual(["1.26.1"]);
  });
});

describe("newestTag", () => {
  test("the newest matching release, with its tag", () => {
    expect(
      newestTag(group.id, group.wraps!, [
        "REL_9_6",
        "REL_18_6",
        "REL_18_4",
        "REL_19_BETA1",
      ]),
    ).toEqual({ tag: "REL_18_6", version: "18.6.0" });
  });

  test("a pattern that matches no tag fails loudly", () => {
    expect(() => newestTag(group.id, group.wraps!, ["other"])).toThrow(
      "no tag",
    );
  });
});

describe("patternProblem", () => {
  test("1–3 capture groups that compile", () => {
    expect(patternProblem("^v(\\d+)\\.(\\d+)$")).toBeUndefined();
    expect(patternProblem("^v\\d+$")).toContain("0 capture groups");
    expect(patternProblem("(")).toContain("does not compile");
  });
});

describe("upstreamRows", () => {
  test("an upstream release no wrapper has published is BLOCKED on the publish", () => {
    expect(rows(["18.3.0"], "18.6.0")).toEqual([
      {
        name: "PostgreSQL (upstream of group `pg-client`)",
        current: "18.3.0",
        latest: "18.6.0",
        waiting: {
          kind: "blocked",
          prerequisite: "publish the client for 18.6.0",
        },
      },
    ]);
  });

  test("once a wrapper for it is published, the registry side reports it", () => {
    // 18.6.1 is a rebuild of upstream 18.6: major.minor agrees.
    expect(rows(["18.3.0", "18.6.1"], "18.6.0")).toEqual([]);
  });

  test("a hold on a member covering the release makes the row HELD", () => {
    const hold: Hold = {
      names: ["@x/pg-b"],
      below: "18.6.0",
      reason: "the server never shipped 18.6",
      reviewBy: "2026-12-01",
    };
    expect(rows(["18.3.0"], "18.6.0", [hold])[0]?.waiting).toEqual({
      kind: "held",
      reason: "the server never shipped 18.6",
      reviewBy: "2026-12-01",
      lapsed: false,
    });
  });

  describe("a wrapper built after another group", () => {
    const server: Group = {
      id: "server",
      members: ["@srv/pg-a", "@srv/pg-b"],
      agree: "version",
      reason: "one build per platform",
    };
    const client: Group = {
      ...group,
      wraps: { ...group.wraps!, after: "server" },
    };
    const afterRows = (serverPublished: string[]) =>
      upstreamRows({
        groups: [client, server],
        packuments: new Map([
          ...client.members.map((m) => [m, pkg("18.3.0")] as const),
          ...server.members.map((m) => [m, pkg(...serverPublished)] as const),
        ]),
        installed: new Map([["@x/pg-a", "18.3.0"]]),
        upstream: new Map([
          [client.id, { release: "18.6.0", taggedAt: TAGGED }],
        ]),
        holds: [],
        today: "2026-10-16",
      });

    test("awaits that group while none of it has published the release", () => {
      expect(afterRows(["18.3.0-beta.17"])).toEqual([
        {
          name: "PostgreSQL (upstream of group `pg-client`)",
          current: "18.3.0",
          latest: "18.6.0",
          waiting: {
            kind: "awaiting",
            on: {
              kind: "publish",
              by: ["@srv"],
              release: "PostgreSQL 18.6",
              since: TAGGED,
            },
          },
        },
      ]);
    });

    test("once that group has it, no row: the lockstep group reports the lag", () => {
      expect(afterRows(["18.3.0-beta.17", "18.6.0-beta.1"])).toEqual([]);
    });
  });
});
