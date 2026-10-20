import { describe, expect, test } from "bun:test";
import { formatInScope, selectChangedHunks } from "./line-scope";
import { formatSource } from "./prettier";

// Three statements prettier would each rewrite. The base is the merge-base
// bytes; the branch then edits only the middle one.
const BASE = "const  a=1\nconst  b=2\nconst  c=3\n";
const EDITED = "const  a=1\nconst  b=20\nconst  c=3\n";

describe("selectChangedHunks", () => {
  test("applies only the hunks over lines the branch changed", async () => {
    expect(
      await selectChangedHunks({
        cur: EDITED,
        formatted: "const a = 1;\nconst b = 20;\nconst c = 3;\n",
        base: BASE,
      }),
    ).toBe("const  a=1\nconst b = 20;\nconst  c=3\n");
  });

  test("a file identical to its base selects nothing", async () => {
    expect(
      await selectChangedHunks({
        cur: BASE,
        formatted: "const a = 1;\nconst b = 2;\nconst c = 3;\n",
        base: BASE,
      }),
    ).toBe(BASE);
  });

  test("a deleted line marks its neighbours", async () => {
    const base = "const  a=1\nconst  gone=0\nconst  c=3\nconst  d=4\n";
    const cur = "const  a=1\nconst  c=3\nconst  d=4\n";
    expect(
      await selectChangedHunks({
        cur,
        formatted: "const a = 1;\nconst c = 3;\nconst d = 4;\n",
        base,
      }),
    ).toBe("const a = 1;\nconst c = 3;\nconst  d=4\n");
  });
});

describe("formatInScope", () => {
  test("a file scope is prettier's whole output", async () => {
    expect(
      await formatInScope({
        file: "a.ts",
        content: EDITED,
        scope: { kind: "file" },
        format: formatSource,
      }),
    ).toBe("const a = 1;\nconst b = 20;\nconst c = 3;\n");
  });

  test("a lines scope leaves untouched lines alone", async () => {
    expect(
      await formatInScope({
        file: "a.ts",
        content: EDITED,
        scope: { kind: "lines", base: BASE },
        format: formatSource,
      }),
    ).toBe("const  a=1\nconst b = 20;\nconst  c=3\n");
  });

  test("its output is its own fixed point (the readers agree with the writer)", async () => {
    const base = [
      "export function f(a: number,",
      "  b: number) {",
      "  return   a+b",
      "}",
      "const  untouched=1",
      "",
    ].join("\n");
    const content = base.replace("return   a+b", "return   a*b");
    const scope = { kind: "lines" as const, base };
    const once = await formatInScope({
      file: "a.ts",
      content,
      scope,
      format: formatSource,
    });
    expect(once).toContain("return a * b;");
    expect(once).toContain("const  untouched=1");
    expect(
      await formatInScope({
        file: "a.ts",
        content: once,
        scope,
        format: formatSource,
      }),
    ).toBe(once);
  });

  test("a selection that would change the program settles on the whole file", async () => {
    // The branch dropped one name from a multi-line import prettier would join.
    // The line diff aligns the block's `import {` with the next import's, so
    // prettier's one edit reads as two hunks; only the deletion touches a
    // changed line, and applying it alone deleted the import (it still parses).
    const base = [
      'import { useEffect } from "react";',
      "import {",
      "  Container,",
      "  Graphics,",
      "  Sprite,",
      "  Texture,",
      "  type Renderer,",
      "  type Ticker,",
      '} from "pixi.js";',
      "import {",
      "  easeOutCubic,",
      "  type FxContext,",
      "  type FxNoteEvent,",
      '} from "@plugins/apps/plugins/sonata/plugins/piano-roll/web";',
      "",
      "export const used = [useEffect, Container, Graphics, Sprite, Texture, easeOutCubic];",
      "export type T = [Renderer, Ticker, FxContext, FxNoteEvent];",
      "",
    ].join("\n");
    const content = base
      .replace("  type Ticker,\n", "")
      .replace("Renderer, Ticker,", "Renderer,");
    const out = await formatInScope({
      file: "a.ts",
      content,
      scope: { kind: "lines", base },
      format: formatSource,
    });
    expect(out).toContain('from "pixi.js"');
    expect(await formatSource({ file: "a.ts", content: out })).toBe(
      await formatSource({ file: "a.ts", content }),
    );
  });

  test("a syntax error in the content itself still throws", async () => {
    let thrown: unknown = null;
    try {
      await formatInScope({
        file: "a.ts",
        content: "const = ;\n",
        scope: { kind: "lines", base: "" },
        format: formatSource,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
  });
});
