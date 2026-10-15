import { test, expect } from "bun:test";
import { join } from "path";
import { tokenGroupsDeclaredIn } from "./token-groups";
import { tokenVarsUsedBy } from "./token-usage";

const root = join(import.meta.dir, "../../../../..");

test("Tailwind classes resolve to the vars the shipped stylesheet reads", async () => {
  const [vars] = await tokenVarsUsedBy(root, [
    [
      {
        file: "x.tsx",
        classes: true,
        content: `cn("bg-linear-140/srgb from-categorical-1-deep bg-categorical-4/15 hover:text-chart-2 rounded-card", "a folder of things")`,
      },
    ],
  ]);
  // An `@theme inline` alias (also through its derived `-deep` shade), an
  // opacity modifier, a variant, and an `@utility` body.
  for (const v of [
    "--categorical-1",
    "--categorical-4",
    "--chart-2",
    "--radius-card",
  ])
    expect(vars!.has(v)).toBe(true);
  // A plain word is no class, so it reads nothing.
  expect([...vars!].some((v) => v.includes("folder"))).toBe(false);
});

test("a literal var() counts, and each group is attributed separately", async () => {
  const [a, b] = await tokenVarsUsedBy(root, [
    [
      {
        file: "a.css",
        content: ".x { color: var(--chart-3); }",
        classes: true,
      },
    ],
    [{ file: "b.tsx", content: `"bg-[var(--avatar-fill)]"`, classes: true }],
  ]);
  expect([...a!]).toEqual(["--chart-3"]);
  expect(b!.has("--avatar-fill")).toBe(true);
  expect(b!.has("--chart-3")).toBe(false);
});

test("words in a file no page renders are not classes", async () => {
  const [server] = await tokenVarsUsedBy(root, [
    [
      {
        file: "s.ts",
        content: `"p-2 bg-categorical-1" + "var(--chart-1)"`,
        classes: false,
      },
    ],
  ]);
  expect([...server!]).toEqual(["--chart-1"]);
});

test("tokenGroupsDeclaredIn reads an inline or same-file const schema", () => {
  expect(
    tokenGroupsDeclaredIn(
      `const schema = { fileBlue: { default: "#00f" }, folder: { default: "#00f" } } satisfies X;
       export const g = defineTokenGroup("file-type", schema);
       export const h = defineTokenGroup("chart", { "chart-1": { default: "red" } });`,
      "group.ts",
    ),
  ).toEqual([
    { id: "file-type", vars: ["--file-blue", "--folder"] },
    { id: "chart", vars: ["--chart-1"] },
  ]);
});

test("a schema it cannot read statically throws rather than losing edges", () => {
  expect(() =>
    tokenGroupsDeclaredIn(
      `defineTokenGroup("x", { ...base, a: { default: "1" } });`,
      "group.ts",
    ),
  ).toThrow(/plain or quoted name/);
  expect(() =>
    tokenGroupsDeclaredIn(`defineTokenGroup("x", makeSchema());`, "group.ts"),
  ).toThrow(/object literal/);
});
