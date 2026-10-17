import { describe, expect, test } from "bun:test";
import { groupProblems, policyProblems, unrangedSpecs } from "./coherence";
import { parseSpec } from "./spec";
import { parseLock, type Declared } from "./workspace";

function declared(name: string, raw: string): Declared {
  return {
    manifest: "package.json",
    workspace: "root",
    section: "dependencies",
    name,
    raw,
    spec: parseSpec(raw),
  };
}

describe("parseSpec", () => {
  test("ranges, exact pins, tags and workspace links", () => {
    expect(parseSpec("^1.2.3")).toEqual({
      kind: "range",
      op: "^",
      version: "1.2.3",
    });
    expect(parseSpec("~6.0.3")).toEqual({
      kind: "range",
      op: "~",
      version: "6.0.3",
    });
    expect(parseSpec("18.3.0-beta.17")).toEqual({
      kind: "exact",
      version: "18.3.0-beta.17",
    });
    expect(parseSpec("latest").kind).toBe("other");
    expect(parseSpec(">=1").kind).toBe("other");
    expect(parseSpec("workspace:*").kind).toBe("workspace");
  });
});

describe("unrangedSpecs", () => {
  test("flags exact pins and tags, with the fix for a pin", () => {
    expect(
      unrangedSpecs([
        declared("a", "^1.0.0"),
        declared("b", "3.9.6"),
        declared("c", "latest"),
      ]),
    ).toEqual([
      'package.json: dependencies.b is "3.9.6" — write "^3.9.6"',
      'package.json: dependencies.c is "latest"',
    ]);
  });
});

describe("policyProblems", () => {
  const base = {
    policyErrors: [],
    declared: [declared("a", "^1.0.0")],
    today: "2026-10-16",
  };

  test("a hold may last 90 days, not more", () => {
    const hold = (reviewBy: string) => ({
      ...base,
      policies: [
        {
          manifest: "package.json",
          policy: {
            holds: [{ names: ["a"], below: "2.0.0", reason: "r", reviewBy }],
          },
        },
      ],
    });
    expect(policyProblems(hold("2027-01-14"))).toEqual([]);
    expect(policyProblems(hold("2027-01-15"))).toEqual([
      expect.stringContaining("at most 90 days unreviewed"),
    ]);
  });

  test("a group naming an undeclared package", () => {
    expect(
      policyProblems({
        ...base,
        policies: [
          {
            manifest: "package.json",
            policy: {
              groups: [
                {
                  id: "g",
                  members: ["a", "zz"],
                  agree: "version",
                  reason: "r",
                },
              ],
            },
          },
        ],
      }),
    ).toEqual([expect.stringContaining("names zz")]);
  });
});

describe("groupProblems over a lock", () => {
  const lock = parseLock(`{
    "lockfileVersion": 1,
    "workspaces": { "": { "name": "root" }, },
    "packages": {
      "a": ["a@1.0.0", "", {}, "sha"],
      "b": ["b@1.0.0", "", {}, "sha"],
      "c": ["c@1.1.0", "", {}, "sha"],
      "x/a": ["a@0.9.0", "", {}, "sha"],
    },
  }`);
  const policies = (members: string[]) => [
    {
      manifest: "package.json",
      policy: {
        groups: [{ id: "g", members, agree: "version" as const, reason: "r" }],
      },
    },
  ];

  test("agreeing members pass", () => {
    expect(groupProblems(policies(["b", "b"]), lock)).toEqual([]);
  });

  test("two copies of a member, and members that disagree", () => {
    expect(groupProblems(policies(["a", "c"]), lock)).toEqual([
      expect.stringContaining("a is locked at 2 versions"),
      expect.stringContaining("must agree on version"),
    ]);
  });
});
