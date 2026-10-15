/**
 * The narrowed lint key (research/2026-10-15-global-lint-cache-per-contribution.md):
 *   1. the lockfile counts only by its npm resolutions — a new workspace entry
 *      changes nothing, a version bump does;
 *   2. a stored entry keeps the newest results per group and drops the rest;
 *   3. exemptions apply when results are read, including the report of a
 *      file-level exemption that suppressed nothing.
 */

import { expect, test } from "bun:test";
import type { ResolvedExemption } from "@plugins/framework/plugins/tooling/plugins/exempt/core";
import type { RawLintMessage } from "../core";
import { hasLintDirective } from "./fingerprint";
import { lockfileLintDigest } from "./lint-groups";
import { mergeLintEntry } from "./lint-results";
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

test("a merged entry puts fresh results first and keeps `keep` of them", () => {
  const prior = mergeLintEntry(
    undefined,
    new Map([
      ["g1-v1", [msg("g1/r")]],
      ["g2-v1", []],
    ]),
    3,
  );
  expect(prior).toEqual({
    known: ["g1-v1", "g2-v1"],
    messages: { "g1-v1": [msg("g1/r")] },
  });
  const next = mergeLintEntry(
    prior,
    new Map([
      ["g1-v2", []],
      ["g2-v1", [msg("g2/r")]],
    ]),
    3,
  );
  // g2-v1 re-recorded moves to the front once; the oldest falls past `keep`.
  expect(next.known).toEqual(["g1-v2", "g2-v1", "g1-v1"]);
  expect(next.messages).toEqual({
    "g2-v1": [msg("g2/r")],
    "g1-v1": [msg("g1/r")],
  });
  const trimmed = mergeLintEntry(next, new Map([["g3-v1", []]]), 2);
  expect(trimmed).toEqual({ known: ["g3-v1", "g1-v2"], messages: {} });
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
