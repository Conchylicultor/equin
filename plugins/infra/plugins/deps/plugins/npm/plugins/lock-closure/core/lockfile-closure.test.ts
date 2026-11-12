import { expect, test } from "bun:test";
import { lockfileNpmClosure } from "./lockfile-closure";

// The shape bun writes, trimmed: workspaces, patchedDependencies, packages —
// `eslint/ignore` is a copy nested under eslint, `@equin/plugin-a/zod` a
// workspace's non-hoisted copy.
const LOCK = `{
  "lockfileVersion": 1,
  "workspaces": {
    "": { "name": "repo" },
    "plugins/a": { "name": "@equin/plugin-a", "version": "0.0.1" },
  },
  "patchedDependencies": {
    "eslint@9.0.0": "patches/eslint@9.0.0.patch",
    "pg@8.0.0": "patches/pg@8.0.0.patch",
  },
  "packages": {
    "@equin/plugin-a": ["@equin/plugin-a@workspace:plugins/a"],
    "@equin/plugin-a/zod": ["zod@3.0.0", "", {}, "sha512-z3"],
    "eslint": ["eslint@9.0.0", "", { "dependencies": { "ignore": "^5", "debug": "^4" }, "peerDependencies": { "jiti": "*" }, "optionalPeers": ["jiti"] }, "sha512-e"],
    "eslint/ignore": ["ignore@5.0.0", "", {}, "sha512-i5"],
    "ignore": ["ignore@7.0.0", "", {}, "sha512-i7"],
    "debug": ["debug@4.0.0", "", { "dependencies": { "ms": "^2" } }, "sha512-d"],
    "ms": ["ms@2.0.0", "", {}, "sha512-m"],
    "pg": ["pg@8.0.0", "", { "dependencies": { "debug": "^4" } }, "sha512-p"],
    "zod": ["zod@4.0.0", "", {}, "sha512-z4"],
  }
}
`;

const keys = (c: { entries: string[] }) =>
  c.entries.map((e) => e.split("\0")[0]);

test("the closure follows dependencies node's way: nested copy first, then up", () => {
  const c = lockfileNpmClosure(LOCK, ["eslint"]);
  // eslint/ignore, not the hoisted ignore@7; an absent optional peer is skipped.
  expect(keys(c)).toEqual(["debug", "eslint", "eslint/ignore", "ms"]);
  expect(c.patches).toEqual(["patches/eslint@9.0.0.patch"]);
  expect(c.missing).toEqual([]);
});

test("a root name is found hoisted and under every workspace", () => {
  expect(keys(lockfileNpmClosure(LOCK, ["zod"]))).toEqual([
    "@equin/plugin-a/zod",
    "zod",
  ]);
});

test("a package outside the closure moves nothing; one inside moves it", () => {
  const before = lockfileNpmClosure(LOCK, ["eslint"]);
  const pgBumped = LOCK.replace('"pg@8.0.0", ""', '"pg@8.1.0", ""');
  expect(lockfileNpmClosure(pgBumped, ["eslint"])).toEqual(before);
  const msBumped = LOCK.replace("ms@2.0.0", "ms@2.1.0");
  expect(lockfileNpmClosure(msBumped, ["eslint"]).entries).not.toEqual(
    before.entries,
  );
});

test("a name the lock does not hold is reported missing", () => {
  expect(lockfileNpmClosure(LOCK, ["left-pad"]).missing).toEqual(["left-pad"]);
});

test("an entry this closure cannot read (not a registry entry) throws", () => {
  const git = LOCK.replace(
    '"ms": ["ms@2.0.0", "", {}, "sha512-m"]',
    '"ms": ["ms@github:vercel/ms#abc", "abc"]',
  );
  expect(() => lockfileNpmClosure(git, ["eslint"])).toThrow(
    "is not a registry entry",
  );
});

test("a lockfile that does not parse throws", () => {
  expect(() => lockfileNpmClosure("{ nope", ["eslint"])).toThrow(
    "bun.lock does not parse",
  );
});
