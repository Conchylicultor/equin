import { beforeAll, describe, expect, test } from "bun:test";
import { init as esLexerInit } from "es-module-lexer/minimal";
import { artifactSourcemaps, isReexportFacade } from "./sourcemaps";

// Rolldown's multi-entry facade, minified and not.
const FACADE = `import { a as e, i as t } from "./web-8dlL1DSP.mjs";\nexport {\n  t as A,\n  e as default\n};\n`;
const FACADE_MIN = `import{a as e}from"./web-x.mjs";export{e as default};`;
const REEXPORT = `export { t as a, n as default } from "./shared-D1Z7gR8O.js";\n`;

describe("isReexportFacade", () => {
  beforeAll(() => esLexerInit);

  test("accepts import + export-list and re-export modules", () => {
    expect(isReexportFacade(FACADE, "index.js")).toBe(true);
    expect(isReexportFacade(FACADE_MIN, "index.js")).toBe(true);
    expect(isReexportFacade(REEXPORT, "index.js")).toBe(true);
  });

  test("rejects a module with code of its own", () => {
    expect(isReexportFacade(`${FACADE}const x = 1;\n`, "index.js")).toBe(false);
    expect(
      isReexportFacade(`const f = () => import("./lazy.mjs");`, "index.js"),
    ).toBe(false);
  });
});

// `expect(p).rejects.toThrow()` is typed `void` under bun:test, so awaiting it
// asserts nothing; this awaits the rejection for real.
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

describe("artifactSourcemaps", () => {
  const read = (files: Record<string, string>) => (name: string) =>
    files[name]!;

  test("lists every module's map; a facade may have none", async () => {
    const files = {
      "index.js": FACADE,
      "exhibits.js": "export const x = 1;",
      "exhibits.js.map": "{}",
      "web-8dlL1DSP.mjs": "export const a = 1;",
      "web-8dlL1DSP.mjs.map": "{}",
      "meta.json": "{}",
    };
    expect(
      await artifactSourcemaps({
        label: "a",
        files: Object.keys(files),
        read: read(files),
      }),
    ).toEqual(["exhibits.js.map", "web-8dlL1DSP.mjs.map"]);
  });

  test("throws on a map-less module holding code", async () => {
    const files = {
      "index.js": "export const x = 1;",
      "chunk.mjs": "export const y = 2;",
      "chunk.mjs.map": "{}",
    };
    const err = await rejection(
      artifactSourcemaps({
        label: "a",
        files: Object.keys(files),
        read: read(files),
      }),
    );
    expect(err.message).toContain("index.js has no index.js.map");
  });

  test("throws when the artifact has no map at all", async () => {
    const files = { "index.js": FACADE };
    const err = await rejection(
      artifactSourcemaps({
        label: "a",
        files: Object.keys(files),
        read: read(files),
      }),
    );
    expect(err.message).toContain("no sourcemap at all");
  });
});
