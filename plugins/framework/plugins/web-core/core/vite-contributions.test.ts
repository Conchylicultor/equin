import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  babelPluginsFor,
  findViteContributions,
  isViteContributionPath,
  loadBabelContributions,
  type OrderedBabelContributions,
} from "./vite-contributions";

const repoRoot = join(import.meta.dir, "../../../../..");
const pluginsRoot = join(repoRoot, "plugins");

describe("babelPluginsFor", () => {
  const contributions: OrderedBabelContributions = [
    { order: -100, plugin: "first", appliesTo: () => true },
    {
      order: 0,
      plugin: "jsx-only",
      appliesTo: ({ id }) => id.endsWith(".tsx"),
    },
  ];

  test("keeps run order and drops a contribution that does not apply", () => {
    expect(
      babelPluginsFor(contributions, { id: "/a/x.tsx", code: "" }),
    ).toEqual(["first", "jsx-only"]);
    expect(babelPluginsFor(contributions, { id: "/a/x.ts", code: "" })).toEqual(
      ["first"],
    );
  });

  test("an empty list when none applies", () => {
    const none: OrderedBabelContributions = [
      { order: 0, plugin: "p", appliesTo: () => false },
    ];
    expect(babelPluginsFor(none, { id: "/a/x.ts", code: "" })).toEqual([]);
  });
});

// The repo's own contributions, through the real loader: what the artifact
// builder runs on which module.
const loaded = await loadBabelContributions({ pluginsRoot, repoRoot });

describe("the repo's contributions", () => {
  const count = (id: string, code: string) =>
    babelPluginsFor(loaded, { id, code }).length;

  test("every one runs on a .tsx module", () => {
    expect(count("/p/web/x.tsx", "export const X = 1;")).toBe(loaded.length);
  });

  test("none runs on a .ts module that names no hook", () => {
    expect(
      count("/p/core/x.ts", "export const sum = (a: number) => a + 1;"),
    ).toBe(0);
  });

  test("the compiler runs on a .ts module that defines or calls a hook", () => {
    expect(
      count("/p/web/use-x.ts", "export function useThing() {}"),
    ).toBeGreaterThan(0);
    expect(
      count("/p/web/x.ts", "const v = React.useMemo(f, []);"),
    ).toBeGreaterThan(0);
  });

  test("the compiler runs on a .ts module opting in with 'use memo'", () => {
    expect(
      count("/p/web/x.ts", 'function f() { "use memo"; }'),
    ).toBeGreaterThan(0);
  });

  test("a lowercase use- word is not a hook", () => {
    expect(count("/p/core/x.ts", "const user = useful + reuse;")).toBe(0);
  });
});

describe("isViteContributionPath", () => {
  test("the filter over the repo's file list finds what the walk finds", async () => {
    const out = Bun.spawnSync(
      ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: repoRoot },
    );
    const filtered = out.stdout
      .toString()
      .split("\0")
      .filter((p) => p.startsWith("plugins/"))
      .map((p) => p.slice("plugins/".length))
      .filter(isViteContributionPath)
      .map((rel) => join(pluginsRoot, rel))
      .sort();
    expect(filtered).toEqual(await findViteContributions(pluginsRoot));
    expect(filtered.length).toBeGreaterThan(0);
  });

  test("the walk's exclusions", () => {
    expect(isViteContributionPath("a/vite/index.ts")).toBe(true);
    expect(isViteContributionPath("a/vite/other.ts")).toBe(false);
    expect(isViteContributionPath("a/node_modules/x/vite/index.ts")).toBe(
      false,
    );
    expect(isViteContributionPath("a/dist.live.1/vite/index.ts")).toBe(false);
    expect(isViteContributionPath("a/vite/b/vite/index.ts")).toBe(false);
  });
});
