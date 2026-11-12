import { describe, expect, it } from "bun:test";
import ts from "typescript";
import { fileTargetUses, literalString, type TargetUse } from "./file-uses";
import type { ParsedFile } from "./result";

const parse = (src: string, rel = "x.ts"): ParsedFile => ({
  rel,
  sf: ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true),
});

/** Targets: `mark` and `other` exported by "./t". */
const uses = (src: string) =>
  fileTargetUses(ts, parse(src), {
    imported: (spec, exported) =>
      spec === "./t" && (exported === "mark" || exported === "other")
        ? exported
        : undefined,
    isTargetModule: (spec) => spec === "./t",
  });

const summary = (u: TargetUse<string>) =>
  u.kind === "call"
    ? `call ${u.key} @${u.site.line}`
    : u.kind === "member-call"
      ? `member ${u.key}.${u.member} @${u.site.line}`
      : u.kind === "reexport"
        ? `reexport ${u.key} as ${u.as}`
        : `reexport-all ${u.specifier} as ${u.as}`;

describe("fileTargetUses", () => {
  it("reads direct, aliased, parenthesized, spread and nested calls", () => {
    const r = uses(
      `import { mark, other as o } from "./t";\nmark("a");\nconst x = { ...o("b") };\n(mark)!("c");\nf(mark?.("d"));`,
    );
    expect(r.unreadable).toEqual([]);
    expect(r.found.map(summary)).toEqual([
      "call mark @2",
      "call other @3",
      "call mark @4",
      "call mark @5",
    ]);
  });

  it("reads member calls and namespace imports", () => {
    const r = uses(
      `import * as T from "./t";\nimport { mark } from "./t";\nT.mark("a");\nmark.register({});\nT.unrelated(1);`,
    );
    expect(r.unreadable).toEqual([]);
    expect(r.found.map(summary)).toEqual([
      "call mark @3",
      "member mark.register @4",
    ]);
  });

  it("returns every value use, shadow and namespace escape as unreadable", () => {
    const r = uses(
      `import { mark } from "./t";\nimport * as T from "./t";\nconst f = mark;\nconst o = { mark };\nfunction g(mark) {}\nT[k]();\nuse(T);\nexport default mark;\nconst d = await import("./t");\nrequire("./t");\nimport("./other");`,
    );
    expect(r.found).toEqual([]);
    expect(r.unreadable.map((u) => u.site.line)).toEqual([
      3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  it("skips non-references: keys, members, type queries, type-only imports", () => {
    const r = uses(
      `import { mark } from "./t";\nimport type { other } from "./t";\nconst o = { mark: 1 };\na.mark;\ntype T = typeof mark;\nother(1);`,
    );
    expect(r).toEqual({ found: [], unreadable: [] });
  });

  it("reports re-exports, named and star", () => {
    const r = uses(
      `import { mark } from "./t";\nexport { mark as m };\nexport { other } from "./t";\nexport * from "./t";\nexport * as ns from "./t";\nexport * from "./u";`,
    );
    expect(r.found.map(summary)).toEqual([
      "reexport other as other",
      "reexport-all ./t as null",
      "reexport-all ./t as ns",
      "reexport mark as m",
    ]);
  });

  it("follows the declaring file's own top-level target", () => {
    const r = fileTargetUses(
      ts,
      parse(`export function mark(x: string) {}\nmark("a");`),
      {
        imported: () => undefined,
        isTargetModule: () => false,
        local: (n) => (n === "mark" ? "mark" : undefined),
      },
    );
    expect(r.unreadable).toEqual([]);
    expect(r.found.map(summary)).toEqual(["call mark @2"]);
  });
});

describe("literalString", () => {
  const arg = (src: string) => {
    const file = parse(`f(${src});`);
    const call = (file.sf.statements[0] as ts.ExpressionStatement)
      .expression as ts.CallExpression;
    return literalString(ts, file, call.arguments[0]!);
  };
  it("reads literals through parentheses and `as const`", () => {
    expect(arg(`"a"`)).toEqual({ kind: "read", value: "a" });
    expect(arg("`b`")).toEqual({ kind: "read", value: "b" });
    expect(arg(`("c" as const)`)).toEqual({ kind: "read", value: "c" });
  });
  it("returns anything else as unreadable, with its site and text", () => {
    const r = arg("cond ? `x` : `y`");
    expect(r.kind).toBe("unreadable");
    if (r.kind === "unreadable")
      expect(r.unreadable).toMatchObject({
        site: { rel: "x.ts", line: 1 },
        text: "cond ? `x` : `y`",
      });
    expect(arg("`a$" + "{b}`").kind).toBe("unreadable");
  });
});
