import { describe, expect, it } from "bun:test";
import ts from "typescript";
import {
  boundConst,
  createSourceAnalysis,
  readRepoCompilerOptions,
  type SourceAnalysis,
} from "./analysis";
import { valueReferences, type TargetUse } from "./file-uses";
import { formatUnreadable } from "./result";

const TSCONFIG = {
  "tsconfig.base.json": `{ "compilerOptions": { "module": "ESNext", "moduleResolution": "bundler", "allowImportingTsExtensions": true, "noEmit": true, "paths": { "@fx/*": ["./fx/*"] } } }`,
  // a comment, as the real one has
  "tsconfig.json": `// root\n{ "extends": "./tsconfig.base.json", "include": ["fx"] }`,
};

async function analysisOver(files: Record<string, string>): Promise<{
  analysis: SourceAnalysis;
  candidatesFor: (g: string) => Promise<{ rel: string; src: string }[]>;
}> {
  const all: Record<string, string> = { ...TSCONFIG, ...files };
  const repo = {
    has: (rel: string) => Object.hasOwn(all, rel),
    read: (rel: string) => Promise.resolve(all[rel] ?? null),
  };
  const analysis = createSourceAnalysis({
    ts,
    files: repo,
    parse: ({ rel, src }) =>
      Promise.resolve(
        ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true),
      ),
    compilerOptions: await readRepoCompilerOptions(ts, repo),
  });
  const candidatesFor = (grepArg: string) => {
    const re = new RegExp(grepArg);
    return Promise.resolve(
      Object.entries(files)
        .filter(([rel, src]) => /\.tsx?$/.test(rel) && re.test(src))
        .map(([rel, src]) => ({ rel, src })),
    );
  };
  return { analysis, candidatesFor };
}

const DEF = "fx/lib/core/def.ts";
const BARREL = "fx/lib/core/index.ts";
const summary = (u: TargetUse<string>) =>
  `${u.kind} ${u.kind === "reexport-all" ? u.specifier : u.key} ${u.file.rel}:${u.site.line}`;

describe("createSourceAnalysis", () => {
  it("resolves specifiers by the repo project's paths: alias, relative, index, external, missing", async () => {
    const { analysis } = await analysisOver({ [DEF]: "", [BARREL]: "" });
    expect(analysis.resolveModule("fx/a/web/x.ts", "@fx/lib/core")).toEqual({
      kind: "repo",
      rel: BARREL,
    });
    expect(analysis.resolveModule(BARREL, "./def")).toEqual({
      kind: "repo",
      rel: DEF,
    });
    expect(analysis.resolveModule(BARREL, "./def.ts")).toEqual({
      kind: "repo",
      rel: DEF,
    });
    expect(analysis.resolveModule(BARREL, "react")).toEqual({
      kind: "external",
    });
    expect(analysis.resolveModule(BARREL, "./nope")).toEqual({
      kind: "missing",
    });
    expect(analysis.resolveModule(BARREL, "@fx/nope/core")).toEqual({
      kind: "missing",
    });
  });

  it("follows an export through aliased, star, import-then-export and local-alias barrels", async () => {
    const { analysis } = await analysisOver({
      [DEF]:
        "export function mark() {}\nconst hidden = 1;\nexport { hidden as shown };",
      [BARREL]: `export { mark as m1 } from "./def";\nexport * from "./def";\nexport * from "./cycle";`,
      "fx/lib/core/cycle.ts": `export * from "./index";`,
      "fx/lib/core/again.ts": `import { m1 } from "./index";\nexport { m1 as m2 };`,
    });
    for (const [rel, name] of [
      [BARREL, "m1"],
      [BARREL, "mark"],
      ["fx/lib/core/again.ts", "m2"],
    ] as const) {
      const b = await analysis.exportedBinding(rel, name);
      expect(
        b.kind === "read" &&
          b.value.kind === "declaration" &&
          b.value.declaration.file.rel,
      ).toBe(DEF);
    }
    const shown = await analysis.exportedBinding(BARREL, "shown");
    expect(
      shown.kind === "read" &&
        shown.value.kind === "declaration" &&
        shown.value.declaration.name,
    ).toBe("hidden");
    const none = await analysis.exportedBinding(BARREL, "absent");
    expect(none.kind).toBe("unreadable");
  });

  it("takes an identifier to its innermost declaration, then a const's initializer", async () => {
    const { analysis } = await analysisOver({
      [DEF]: `export const TABLE = pgTable("t");`,
      "fx/a/core/x.ts": `import { TABLE as T } from "@fx/lib/core/def";\nconst a = T;\nfunction f(T) { return T; }\nlet b = 1;\nuse(a, b);`,
    });
    const file = (await analysis.file("fx/a/core/x.ts"))!;
    const ids: ts.Identifier[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n)) ids.push(n);
      ts.forEachChild(n, visit);
    };
    visit(file.sf);
    const at = (text: string, line: number) =>
      ids.find(
        (i) =>
          i.text === text &&
          file.sf.getLineAndCharacterOfPosition(i.getStart()).line + 1 === line,
      )!;

    const imported = await analysis.bindingOf(file, at("T", 2));
    expect(
      imported.kind === "read" && imported.value.kind === "declaration",
    ).toBe(true);
    if (imported.kind === "read" && imported.value.kind === "declaration") {
      expect(imported.value.declaration.file.rel).toBe(DEF);
      const init = analysis.initializerOf(imported.value.declaration);
      expect(init.kind === "read" && init.value.getText()).toBe(`pgTable("t")`);
    }
    const param = await analysis.bindingOf(file, at("T", 3));
    expect(
      param.kind === "read" &&
        param.value.kind === "declaration" &&
        ts.isParameter(param.value.declaration.node),
    ).toBe(true);
    const letB = await analysis.bindingOf(file, at("b", 5));
    expect(
      letB.kind === "read" &&
        letB.value.kind === "declaration" &&
        analysis.initializerOf(letB.value.declaration).kind,
    ).toBe("unreadable");
    const global = await analysis.bindingOf(file, at("use", 5));
    expect(global.kind === "read" && global.value).toEqual({
      kind: "global",
      name: "use",
    });
  });

  it("collects every use of a target through barrels and aliases, fail-closed", async () => {
    const { analysis, candidatesFor } = await analysisOver({
      [DEF]: `export function mark(x: string) {}\nmark("own");`,
      [BARREL]: `export { mark } from "./def";`,
      "fx/lib/core/alias.ts": `export { mark as tag } from "./index";`,
      "fx/a/web/direct.ts": `import { mark } from "@fx/lib/core";\nmark("a");`,
      "fx/a/web/aliased.ts": `import { tag as t } from "@fx/lib/core/alias";\nt("b");`,
      "fx/a/web/ns.ts": `import * as L from "@fx/lib/core";\nL.mark("c");\nL[k]("d");`,
      "fx/a/web/passed.ts": `import { mark } from "@fx/lib/core";\nlist.map(mark);`,
      "fx/a/web/broken.ts": `import { mark } from "./gone";\nmark("e");`,
      "fx/a/web/unrelated.ts": `import { mark } from "other-pkg";\nmark("z");`,
      "fx/a/web/dynamic.ts": `const m = await import("@fx/lib/core");\nm[k]("f");`,
      "fx/lib/core/nsbarrel.ts": `export * as lib from "./index";`,
      "fx/a/web/nsimport.ts": `import { lib } from "@fx/lib/core/nsbarrel";\nlib[k]("g");`,
    });
    const r = await analysis.usesOf(
      { mark: { rel: BARREL, name: "mark" } },
      candidatesFor,
    );
    expect(r.found.map(summary).sort()).toEqual(
      [
        "call mark fx/lib/core/def.ts:2",
        "reexport mark fx/lib/core/index.ts:1",
        "reexport mark fx/lib/core/alias.ts:1",
        "reexport-all ./index fx/lib/core/nsbarrel.ts:1",
        "call mark fx/a/web/direct.ts:2",
        "call mark fx/a/web/aliased.ts:2",
        "call mark fx/a/web/ns.ts:2",
      ].sort(),
    );
    expect(r.unreadable.map(formatUnreadable).sort()).toEqual([
      expect.stringMatching(
        /^fx\/a\/web\/broken\.ts:1: "\.\/gone" resolves to no file/,
      ),
      expect.stringMatching(
        /^fx\/a\/web\/dynamic\.ts:1: a module exporting a target is loaded dynamically/,
      ),
      expect.stringMatching(/^fx\/a\/web\/ns\.ts:3: the namespace `L`/),
      expect.stringMatching(
        /^fx\/a\/web\/nsimport\.ts:1: `lib` from "@fx\/lib\/core\/nsbarrel" is a namespace re-export/,
      ),
      expect.stringMatching(
        /^fx\/a\/web\/passed\.ts:2: `mark` is used other than called/,
      ),
    ]);
  });

  it("reads a destructured export as a declaration, and a JSON module as data", async () => {
    const { analysis, candidatesFor } = await analysisOver({
      [DEF]: "export const { mark, other } = makeRuntime();",
      [BARREL]: 'export { mark } from "./def";',
      "fx/lib/core/names.json": '["a"]',
      "fx/a/web/x.ts":
        'import { mark } from "@fx/lib/core";\nimport names from "@fx/lib/core/names.json";\nmark(names);',
    });
    const b = await analysis.exportedBinding(BARREL, "mark");
    expect(
      b.kind === "read" &&
        b.value.kind === "declaration" &&
        ts.isBindingElement(b.value.declaration.node),
    ).toBe(true);
    if (b.kind === "read" && b.value.kind === "declaration")
      expect(analysis.initializerOf(b.value.declaration).kind).toBe(
        "unreadable",
      );
    const uses = await analysis.usesOf(
      { mark: { rel: BARREL, name: "mark" } },
      candidatesFor,
    );
    expect(uses.found.map(summary)).toEqual([
      "reexport mark fx/lib/core/index.ts:1",
      "call mark fx/a/web/x.ts:3",
    ]);
    expect(uses.unreadable).toEqual([]);
    const file = (await analysis.file("fx/a/web/x.ts"))!;
    const names = valueReferences(ts, file.sf).find((i) => i.text === "names")!;
    const json = await analysis.bindingOf(file, names);
    expect(json.kind === "read" && json.value.kind).toBe("external");
  });

  it("a global is only a name the file does not declare: hoisted vars and unfollowed forms are not", async () => {
    const { analysis } = await analysisOver({
      "fx/a/core/x.ts":
        'if (c) { var h = 1; }\nimport q = require("./q");\nuse(h, q, Date);',
    });
    const file = (await analysis.file("fx/a/core/x.ts"))!;
    const refs = valueReferences(ts, file.sf);
    const of = async (name: string) => {
      const b = await analysis.bindingOf(
        file,
        refs.find((i) => i.text === name)!,
      );
      return b.kind === "read" ? b.value.kind : b.kind;
    };
    expect(await of("h")).toBe("declaration");
    expect(await of("q")).toBe("unreadable");
    expect(await of("Date")).toBe("global");
  });

  it("boundConst binds through parens, casts and either arm of a ternary — never the condition", async () => {
    const { analysis } = await analysisOver({
      "fx/a/core/x.ts":
        "const a = (f() as T);\nconst b = flag ? f() : g();\nconst c = f() ? 1 : 2;\nlet d = f();\nuse(f());",
    });
    const file = (await analysis.file("fx/a/core/x.ts"))!;
    const calls: ts.CallExpression[] = [];
    const visit = (n: ts.Node): void => {
      if (
        ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === "f"
      )
        calls.push(n);
      ts.forEachChild(n, visit);
    };
    visit(file.sf);
    expect(calls.map((c) => boundConst(ts, file, c)?.name ?? null)).toEqual([
      "a",
      "b",
      null,
      null,
      null,
    ]);
  });

  it("valueReferences skips member names, keys, declarations and type positions", async () => {
    const { analysis } = await analysisOver({
      "fx/a/core/x.ts":
        "const k: Foo<Bar> = a.b({ c: d, e }, f as G);\ntype H = typeof i;\nfunction j(l) { return l; }",
    });
    const file = (await analysis.file("fx/a/core/x.ts"))!;
    expect(valueReferences(ts, file.sf).map((i) => i.text)).toEqual([
      "a",
      "d",
      "e",
      "f",
      "l",
    ]);
  });
});
