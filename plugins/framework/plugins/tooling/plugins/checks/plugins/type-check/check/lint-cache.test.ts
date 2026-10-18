/**
 * The narrowed lint key (research/2026-10-15-global-lint-cache-per-contribution.md):
 *   1. the lockfile counts only by its npm resolutions — a new workspace entry
 *      changes nothing, a version bump does;
 *   2. a stored entry keeps the newest results per part (syntactic group keys
 *      and typed keys, each with its own budget) and drops the rest;
 *   3. exemptions apply when results are read, including the report of a
 *      file-level exemption that suppressed nothing;
 *   4. each typed part's rules key moves with its own group only, and only
 *      groups holding a type-aware rule have one
 *      (research/2026-10-18-global-typed-lint-key-stops-at-contracts.md);
 *   5. a key a run reused moves up beside the fresh ones, so a result in use
 *      is never the one evicted — and a run that changes no order writes
 *      nothing.
 */

import { expect, test } from "bun:test";
import type { ResolvedExemption } from "@plugins/framework/plugins/tooling/plugins/exempt/core";
import type { RawLintMessage } from "../core";
import { hasLintDirective } from "./fingerprint";
import {
  lockfileLintDigest,
  typedGroupFps,
  type LintGroups,
} from "./lint-groups";
import { mergeLintEntry, sameEntry } from "./lint-results";
import { lintViolationLines } from "./lint-verdict";

// The shape bun writes, trimmed: a workspaces section, then packages, where a
// workspace package's line names `@workspace:`.
const LOCK = `{
  "lockfileVersion": 1,
  "workspaces": {
    "": {
      "name": "repo",
    },
    "plugins/a": {
      "name": "@singularity/plugin-a",
      "version": "0.0.1",
    },
  },
  "packages": {
    "@singularity/plugin-a": ["@singularity/plugin-a@workspace:plugins/a"],

    "eslint": ["eslint@9.39.4", "", {}, "sha512-x"],
  }
}
`;

test("a workspace-only lockfile change keeps the lint digest", () => {
  const added = LOCK.replace(
    `  },\n  "packages": {`,
    `    "plugins/b": {\n      "name": "@singularity/plugin-b",\n      "version": "0.0.1",\n    },\n  },\n  "packages": {`,
  ).replace(
    `\n    "eslint"`,
    `\n    "@singularity/plugin-b": ["@singularity/plugin-b@workspace:plugins/b"],\n\n    "eslint"`,
  );
  expect(added).not.toBe(LOCK);
  expect(lockfileLintDigest(added)).toBe(lockfileLintDigest(LOCK));
});

test("an npm resolution change moves the lint digest", () => {
  const bumped = LOCK.replace("eslint@9.39.4", "eslint@9.40.0");
  expect(lockfileLintDigest(bumped)).not.toBe(lockfileLintDigest(LOCK));
});

test("an unrecognised lockfile layout hashes the whole file", () => {
  const flat = LOCK.replace(`  "workspaces": {`, `"workspaces": {`);
  const flatAdded = flat.replace("plugin-a@workspace", "plugin-z@workspace");
  expect(lockfileLintDigest(flatAdded)).not.toBe(lockfileLintDigest(flat));
});

const msg = (ruleId: string | null, line = 1): RawLintMessage => ({
  ruleId,
  fatal: false,
  line,
  column: 1,
  message: "m",
});

const update = (
  syntactic: [string, RawLintMessage[]][],
  typed: [string, RawLintMessage[]][] = [],
  keepSyntactic = 3,
  keepTyped = 2,
  reused: { syntactic?: string[]; typed?: string[] } = {},
) => ({
  syntactic: new Map(syntactic),
  typed: new Map(typed),
  reusedSyntactic: new Set(reused.syntactic),
  reusedTyped: new Set(reused.typed),
  keepSyntactic,
  keepTyped,
});

test("a merged entry puts fresh results first and keeps `keep` of them", () => {
  const prior = mergeLintEntry(
    undefined,
    update([
      ["g1-v1", [msg("g1/r")]],
      ["g2-v1", []],
    ]),
  );
  expect(prior).toEqual({
    syntactic: ["g1-v1", "g2-v1"],
    typed: [],
    messages: { "g1-v1": [msg("g1/r")] },
  });
  const next = mergeLintEntry(
    prior,
    update([
      ["g1-v2", []],
      ["g2-v1", [msg("g2/r")]],
    ]),
  );
  // g2-v1 re-recorded moves to the front once; the oldest falls past `keep`.
  expect(next.syntactic).toEqual(["g1-v2", "g2-v1", "g1-v1"]);
  expect(next.messages).toEqual({
    "g2-v1": [msg("g2/r")],
    "g1-v1": [msg("g1/r")],
  });
  const trimmed = mergeLintEntry(next, update([["g3-v1", []]], [], 2));
  expect(trimmed).toEqual({
    syntactic: ["g3-v1", "g1-v2"],
    typed: [],
    messages: {},
  });
});

test("typed keys are kept on their own budget, apart from the syntactic ones", () => {
  const e1 = mergeLintEntry(
    undefined,
    update([["s1", []]], [["t1", [msg("x/typed")]]]),
  );
  const e2 = mergeLintEntry(e1, update([], [["t2", []]]));
  const e3 = mergeLintEntry(e2, update([], [["t3", [msg("x/typed", 2)]]]));
  // Three typed versions under a budget of two: the oldest goes, with its
  // messages; the syntactic key is untouched by any of it.
  expect(e3).toEqual({
    syntactic: ["s1"],
    typed: ["t3", "t2"],
    messages: { t3: [msg("x/typed", 2)] },
  });
});

const exemption = (rule: string, target: string): ResolvedExemption =>
  ({
    rule,
    target,
    path: target,
    manifest: "plugins/apps-core/exempt/index.ts",
    kind: "sanctioned",
    reason: "r",
  }) as ResolvedExemption;

test("exemptions are applied to stored results when they are read", () => {
  const files = [
    {
      rel: "plugins/apps-core/web/a.ts",
      messages: [msg("x/rule", 3), msg("y/rule", 4)],
    },
    { rel: "plugins/apps-core/web/b.ts", messages: [msg(null, 5)] },
  ];
  expect(
    lintViolationLines(files, [exemption("x/rule", "plugins/apps-core/web")]),
  ).toEqual([
    "plugins/apps-core/web/a.ts:4:1  y/rule  m",
    "plugins/apps-core/web/b.ts:5:1  (unused-disable)  m",
  ]);
});

test("a file-level exemption that suppressed nothing is reported", () => {
  const files = [{ rel: "plugins/apps-core/web/a.ts", messages: [] }];
  const [line] = lintViolationLines(files, [
    exemption("x/rule", "plugins/apps-core/web/a.ts"),
  ]);
  expect(line).toContain(
    "plugins/apps-core/web/a.ts:1:1  (unused-exemption)  suppressed nothing",
  );
});

test("only directive-carrying text makes a file one unit", () => {
  expect(hasLintDirective("// eslint-disable-next-line x/y -- why")).toBe(true);
  expect(hasLintDirective("/* eslint x/y: off */")).toBe(true);
  expect(hasLintDirective("export const eslintConfig = 1;")).toBe(false);
});

test("a reused key moves up, so it outlives keys nobody uses", () => {
  // t1 is in use (reused every run) while a sibling writes t2, then t3.
  const e1 = mergeLintEntry(undefined, update([], [["t1", [msg("x/typed")]]]));
  const e2 = mergeLintEntry(e1, update([], [["t2", []]]));
  expect(e2.typed).toEqual(["t2", "t1"]);
  const e3 = mergeLintEntry(e2, update([], [], 3, 2, { typed: ["t1"] }));
  expect(e3.typed).toEqual(["t1", "t2"]);
  const e4 = mergeLintEntry(e3, update([], [["t3", []]]));
  // Without the move, t1 would have been the oldest and gone.
  expect(e4).toEqual({
    syntactic: [],
    typed: ["t3", "t1"],
    messages: { t1: [msg("x/typed")] },
  });
});

test("reusing keys already in front changes nothing, so nothing is written", () => {
  const e1 = mergeLintEntry(
    undefined,
    update(
      [
        ["s1", []],
        ["s2", [msg("g/r")]],
      ],
      [["t1", []]],
    ),
  );
  const again = mergeLintEntry(
    e1,
    update([], [], 3, 2, { syntactic: ["s1", "s2"], typed: ["t1"] }),
  );
  expect(sameEntry(e1, again)).toBe(true);
  // A fresh result for a key it already holds, with other messages, is a change.
  expect(
    sameEntry(e1, mergeLintEntry(e1, update([["s1", [msg("g/r")]]]))),
  ).toBe(false);
});

const lintGroups = (
  fps: Record<string, string>,
  typedEngineFp = "te1",
): LintGroups => ({
  fps: new Map(Object.entries(fps)),
  engineFiles: 1,
  typedEngineFp,
  allFp: "all",
});

test("each typed part moves with its own group only", () => {
  const typeAware = {
    base: true,
    contributions: new Set(["typed/one", "typed/two"]),
  };
  const groups = {
    "(base)": "b1",
    "typed/one": "o1",
    "typed/two": "w1",
    "syntactic/plugin": "s1",
  };
  const before = typedGroupFps(lintGroups(groups), typeAware);
  // Only the groups holding a type-aware rule have a typed part.
  expect([...before.keys()]).toEqual(["(base)", "typed/one", "typed/two"]);
  const moved = (after: Map<string, string>): string[] =>
    [...before.keys()].filter((g) => before.get(g) !== after.get(g));
  // A syntactic-only contribution's edit: every typed part stands.
  expect(
    moved(
      typedGroupFps(
        lintGroups({ ...groups, "syntactic/plugin": "s2" }),
        typeAware,
      ),
    ),
  ).toEqual([]);
  // One type-aware contribution's edit: its part only.
  expect(
    moved(
      typedGroupFps(lintGroups({ ...groups, "typed/one": "o2" }), typeAware),
    ),
  ).toEqual(["typed/one"]);
  // The typed engine (the type fingerprint's code): every typed part.
  expect(moved(typedGroupFps(lintGroups(groups, "te2"), typeAware))).toEqual([
    "(base)",
    "typed/one",
    "typed/two",
  ]);
});

test("a type-aware contribution with no rule group is refused", () => {
  expect(() =>
    typedGroupFps(lintGroups({ "(base)": "b1" }), {
      base: true,
      contributions: new Set(["missing/plugin"]),
    }),
  ).toThrow("has no rule group");
});
