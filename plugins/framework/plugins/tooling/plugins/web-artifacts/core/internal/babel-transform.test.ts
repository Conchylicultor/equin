import { describe, expect, test } from "bun:test";
import type { OrderedBabelContributions } from "@plugins/framework/plugins/web-core/core";
import { babelContributionsPlugin } from "./babel-transform";

// A Babel plugin that renames every identifier `a` to `b`: visible in the output.
const renameA = () => ({
  visitor: {
    Identifier(path: { node: { name: string } }) {
      if (path.node.name === "a") path.node.name = "b";
    },
  },
});

const transformOf = (contributions: OrderedBabelContributions) => {
  const plugin = babelContributionsPlugin(contributions);
  const hook = plugin.transform as {
    handler: (
      code: string,
      id: string,
    ) => Promise<{ code: string } | undefined>;
  };
  return (code: string, id: string) => hook.handler(code, id);
};

describe("babelContributionsPlugin", () => {
  test("runs a contribution on the modules it applies to", async () => {
    const transform = transformOf([
      { order: 0, plugin: renameA, appliesTo: () => true },
    ]);
    const out = await transform("export const a = 1;", "/p/web/x.ts");
    expect(out?.code).toContain("const b = 1");
  });

  test("leaves a module no contribution applies to untouched (no Babel pass)", async () => {
    const transform = transformOf([
      { order: 0, plugin: renameA, appliesTo: ({ id }) => id.endsWith(".tsx") },
    ]);
    expect(
      await transform("export const a = 1;", "/p/web/x.ts"),
    ).toBeUndefined();
  });

  test("parses JSX and TypeScript in a .tsx module", async () => {
    const transform = transformOf([
      { order: 0, plugin: renameA, appliesTo: () => true },
    ]);
    const out = await transform(
      "export const a = (p: { x: number }) => <div>{p.x}</div>;",
      "/p/web/x.tsx",
    );
    expect(out?.code).toContain("<div>");
    expect(out?.code).toContain("const b");
  });
});
