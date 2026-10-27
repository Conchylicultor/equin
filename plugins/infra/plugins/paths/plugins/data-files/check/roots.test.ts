import { describe, expect, test } from "bun:test";
import ts from "typescript";
import {
  parseRootBindings,
  parseRootDeclarations,
  pluginOfModule,
  rootOwnerProblems,
  rootsBoundProblems,
  selfAndAncestors,
} from "./roots";

const SERVER = "@plugins/infra/plugins/paths/plugins/data-files/server";
const MACHINE = "@plugins/infra/plugins/paths/plugins/data-files/machine";

const declSrc = `
import { defineFileRoot } from "${SERVER}";
export const protoFiles = defineFileRoot({ id: "apps.prototypes", dir: "apps/prototypes" });
`;
const declModule = "plugins/apps/plugins/prototypes/server/internal/roots.ts";

const bindSrc = (from: string) => `
import { FileRootLocation } from "${MACHINE}";
import { protoFiles } from "${from}";
import { prototypesDir } from "../data-dirs";
export default { contributions: [FileRootLocation(protoFiles, prototypesDir)] };
`;
const bindModule = "plugins/apps/plugins/prototypes/machine/index.ts";

describe("parsing", () => {
  test("a declaration: plugin, const, id, dir", () => {
    expect(parseRootDeclarations(ts, declModule, declSrc)).toEqual([
      {
        module: declModule,
        line: 3,
        plugin: "apps/plugins/prototypes",
        constName: "protoFiles",
        id: "apps.prototypes",
        dir: "apps/prototypes",
      },
    ]);
  });

  test("a call to some other defineFileRoot is not a declaration", () => {
    expect(
      parseRootDeclarations(
        ts,
        declModule,
        `function defineFileRoot(x: unknown) {} defineFileRoot({ id: "x", dir: "y" });`,
      ),
    ).toEqual([]);
  });

  test("a binding through the barrel or a relative path names the declaring plugin", () => {
    for (const from of [
      "@plugins/apps/plugins/prototypes/server",
      "../server",
      "../server/internal/roots",
    ]) {
      expect(parseRootBindings(ts, bindModule, bindSrc(from))).toEqual([
        {
          module: bindModule,
          line: 5,
          rootPlugin: "apps/plugins/prototypes",
          rootName: "protoFiles",
        },
      ]);
    }
  });
});

describe("roots-bound", () => {
  const decls = parseRootDeclarations(ts, declModule, declSrc);
  const bound = parseRootBindings(
    ts,
    bindModule,
    bindSrc("@plugins/apps/plugins/prototypes/server"),
  );

  test("one binding passes", () => {
    expect(rootsBoundProblems(decls, bound)).toEqual([]);
  });

  test("no binding fails, naming the fix", () => {
    const [p] = rootsBoundProblems(decls, []);
    expect(p).toContain("has no FileRootLocation");
  });

  test("two bindings fail", () => {
    expect(rootsBoundProblems(decls, [...bound, ...bound])[0]).toContain(
      "bound 2 times",
    );
  });

  test("a duplicate id, a non-literal spec and a misplaced declaration fail", () => {
    const dup = parseRootDeclarations(
      ts,
      "plugins/apps/plugins/places/server/x.ts",
      `import { defineFileRoot } from "${SERVER}";
       export const o = defineFileRoot({ id: "apps.prototypes", dir: DIR });
       defineFileRoot({ id: "loose", dir: "apps/other" });`,
    );
    const misplaced = parseRootDeclarations(
      ts,
      "plugins/apps/plugins/places/core/x.ts",
      `import { defineFileRoot } from "${SERVER}";
       export const c = defineFileRoot({ id: "in-core", dir: "apps/other" });`,
    );
    const problems = rootsBoundProblems(
      [...decls, ...dup, ...misplaced],
      bound,
    );
    expect(problems.some((p) => p.includes("also declared"))).toBe(true);
    expect(problems.some((p) => p.includes("string-literal"))).toBe(true);
    expect(problems.some((p) => p.includes("bound to a const"))).toBe(true);
    expect(problems.some((p) => p.includes("outside a server/"))).toBe(true);
  });

  test("a binding outside machine/, or of something that is no root, fails", () => {
    const stray = parseRootBindings(
      ts,
      "plugins/apps/plugins/prototypes/server/index.ts",
      bindSrc("@plugins/apps/plugins/elsewhere/server"),
    );
    const problems = rootsBoundProblems(decls, [...bound, ...stray]);
    expect(problems.some((p) => p.includes("outside a machine/"))).toBe(true);
    expect(problems.some((p) => p.includes("not a file root"))).toBe(true);
  });
});

describe("root-owner", () => {
  test("ancestors, nearest first", () => {
    expect(
      selfAndAncestors("apps/plugins/prototypes/plugins/thumbnails"),
    ).toEqual([
      "apps/plugins/prototypes/plugins/thumbnails",
      "apps/plugins/prototypes",
      "apps",
    ]);
    expect(pluginOfModule("plugins/apps/plugins/places/server/x.ts")).toEqual({
      plugin: "apps/plugins/places",
      folder: "server",
    });
  });

  const sub = parseRootDeclarations(
    ts,
    "plugins/apps/plugins/prototypes/plugins/files/server/roots.ts",
    `import { defineFileRoot } from "${SERVER}";
     export const f = defineFileRoot({ id: "apps.prototypes.files", dir: "apps/prototypes" });`,
  );
  const dirs = (map: Record<string, string[]>) => (p: string) =>
    new Set(map[p] ?? []);

  test("a dir an ancestor declares passes", () => {
    expect(
      rootOwnerProblems(
        sub,
        dirs({ "apps/plugins/prototypes": ["apps/prototypes"] }),
      ),
    ).toEqual([]);
  });

  test("a dir another plugin declares fails", () => {
    expect(
      rootOwnerProblems(
        sub,
        dirs({ "apps/plugins/desktop": ["apps/prototypes"] }),
      )[0],
    ).toContain("neither");
  });
});
