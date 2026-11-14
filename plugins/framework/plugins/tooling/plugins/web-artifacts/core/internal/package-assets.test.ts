import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as esbuild from "esbuild";
import {
  asAppPath,
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { sha256Hex } from "../hash";
import {
  isFileInput,
  packageAssetPath,
  rewritePackageAssetUrls,
  rewriteUrlRefs,
  urlAssetRefs,
} from "./package-assets";

describe("isFileInput", () => {
  test("a relative or absolute path is a file", () => {
    expect(isFileInput("node_modules/.bun/a@1/node_modules/a/index.js")).toBe(
      true,
    );
    expect(isFileInput("../../node_modules/a/index.js")).toBe(true);
    expect(isFileInput("/abs/node_modules/a/index.js")).toBe(true);
  });

  test("a module a browser field disables is not", () => {
    expect(
      isFileInput(
        "(disabled):node_modules/.bun/util@0.12.5/node_modules/util/util.js",
      ),
    ).toBe(false);
  });
});

describe("urlAssetRefs", () => {
  test("collects relative non-code URL refs", () => {
    const src = `new URL("./a.wasm", import.meta.url); new URL("./b.js", import.meta.url)`;
    expect(urlAssetRefs(src)).toEqual(["./a.wasm"]);
  });
});

const URL_A = "/artifacts/0123456789abcdef.a.wasm/a.wasm";
const URL_B = "/artifacts/fedcba9876543210.b.data/b.data";

/** Absolute generated columns of each line's segments (field 0 only). */
function columns(mappings: string): number[][] {
  return mappings.split(";").map((line) => {
    if (line === "") return [];
    let col = 0;
    return line.split(",").map((seg) => {
      col += vlq(seg)[0]!;
      return col;
    });
  });
}

function vlq(seg: string): number[] {
  const B64 =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const out: number[] = [];
  let value = 0;
  let shift = 0;
  for (const c of seg) {
    const d = B64.indexOf(c);
    value += (d & 31) << shift;
    if (d & 32) shift += 5;
    else {
      out.push(value & 1 ? -(value >>> 1) : value >>> 1);
      value = 0;
      shift = 0;
    }
  }
  return out;
}

describe("rewriteUrlRefs", () => {
  test("rewrites the three ref forms, minified too, and leaves others alone", () => {
    const code = [
      `const a = new URL("./a.wasm", import.meta.url);`,
      `const b=new URL("a.wasm",import.meta.url),c=new URL('../x/b.data',import.meta.url);`,
      `new URL("./other.wasm", import.meta.url); new URL("https://x.dev/a.wasm", import.meta.url);`,
    ].join("\n");
    const out = rewriteUrlRefs(code, "AAAA;AAAA;AAAA", [
      { ref: "./a.wasm", url: URL_A },
      { ref: "a.wasm", url: URL_A },
      { ref: "../x/b.data", url: URL_B },
    ]);
    expect(out.code).toBe(
      [
        `const a = new URL("${URL_A}", import.meta.url);`,
        `const b=new URL("${URL_A}",import.meta.url),c=new URL('${URL_B}',import.meta.url);`,
        `new URL("./other.wasm", import.meta.url); new URL("https://x.dev/a.wasm", import.meta.url);`,
      ].join("\n"),
    );
  });

  test("shifts later segments on that line only, adding up over two literals", () => {
    const line0 = `x;new URL("./a.wasm",import.meta.url);y;new URL("./a.wasm",import.meta.url);z`;
    const code = `${line0}\nnew URL("./a.wasm",import.meta.url)`;
    const first = line0.indexOf('"./a.wasm"') + 1;
    const y = line0.indexOf("y");
    const z = line0.indexOf("z");
    // Line 0: segments at 0, first (literal start), y, z; line 1: one at 0.
    // Built by hand: deltas 0, first, y-first, z-y; sources fields varied so
    // their relative encoding is visibly kept.
    const enc = (n: number) => {
      const B64 =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      let v = n < 0 ? (-n << 1) | 1 : n << 1;
      let s = "";
      do {
        let d = v & 31;
        v >>>= 5;
        if (v > 0) d |= 32;
        s += B64[d];
      } while (v > 0);
      return s;
    };
    const seg = (col: number, rest: number[]) =>
      [col, ...rest].map(enc).join("");
    const line1 = seg(0, [0, 3, 1]);
    const mappings = [
      [
        seg(0, [0, 0, 0]),
        seg(first, [0, 0, 4]),
        seg(y - first, [0, 1, 0]),
        seg(z - y, [0, 0, 2]),
      ].join(","),
      line1,
    ].join(";");
    const out = rewriteUrlRefs(code, mappings, [
      { ref: "./a.wasm", url: URL_A },
    ]);
    const delta = URL_A.length - "./a.wasm".length;
    expect(columns(out.mappings)).toEqual([
      [0, first, y + delta, z + 2 * delta],
      [0],
    ]);
    // Every column still points at the same character.
    const outLine0 = out.code.split("\n")[0]!;
    expect(outLine0[y + delta]).toBe("y");
    expect(outLine0[z + 2 * delta]).toBe("z");
    // The other line is byte-identical; non-column fields kept.
    expect(out.mappings.split(";")[1]).toBe(line1);
    expect(
      out.mappings
        .split(";")[0]!
        .split(",")
        .map((s) => vlq(s).slice(1)),
    ).toEqual([
      [0, 0, 0],
      [0, 0, 4],
      [0, 1, 0],
      [0, 0, 2],
    ]);
  });

  test("an output with no ref to rewrite is returned as is", () => {
    const code = `new URL("./b.wasm", import.meta.url)`;
    expect(rewriteUrlRefs(code, "AAAA", [])).toEqual({
      code,
      mappings: "AAAA",
    });
  });

  test("a ref its output holds no literal for throws (it would 404)", () => {
    // esbuild printed it in a form the rewrite does not read.
    const code = `new URL(\`./a.wasm\`, import.meta.url); new URL("./b.wasm", import.meta.url)`;
    expect(() =>
      rewriteUrlRefs(code, "AAAA", [{ ref: "./a.wasm", url: URL_A }]),
    ).toThrow(/"a\.wasm".*404/);
  });

  test("one ref naming two files throws", () => {
    expect(() =>
      rewriteUrlRefs(`new URL("./a.wasm", import.meta.url)`, "AAAA", [
        { ref: "./a.wasm", url: URL_A },
        { ref: "a.wasm", url: URL_B },
      ]),
    ).toThrow(/names two files/);
  });
});

describe("rewritePackageAssetUrls", () => {
  async function build(base: AppPath) {
    const outdir = joinAppPath(base, "out");
    const result = await esbuild.build({
      entryPoints: [joinAppPath(base, "node_modules", "pkg", "index.js")],
      bundle: true,
      format: "esm",
      outdir,
      sourcemap: true,
      metafile: true,
      write: true,
      absWorkingDir: base,
      logLevel: "silent",
    });
    return { outdir, metafile: result.metafile };
  }

  test("points the output at the asset's own entry, published once", async () => {
    const base = asAppPath(mkdtempSync(join(tmpdir(), "package-assets-")));
    const pkg = joinAppPath(base, "node_modules", "pkg");
    mkdirSync(pkg, { recursive: true });
    // Compressible and past the 1 KiB floor, so its entry has sidecars.
    const bytes = "package asset bytes ".repeat(200);
    writeFileSync(joinAppPath(pkg, "a.data"), bytes);
    writeFileSync(
      joinAppPath(pkg, "index.js"),
      `export const url = new URL("./a.data", import.meta.url);\nexport function after() { return "after-marker"; }\n`,
    );
    const assetsRoot = joinAppPath(base, "assets");
    const name = `${sha256Hex(bytes).slice(0, 16)}.a.data`;
    const pins: string[] = [];
    const pin = (paths: readonly AppPath[]) => {
      pins.push(...paths);
      return Promise.resolve();
    };

    const first = await build(base);
    const names = await rewritePackageAssetUrls({
      metafile: first.metafile,
      cwd: base,
      pin,
      assetsRoot,
    });
    expect(names).toEqual([name]);
    expect(pins).toEqual([packageAssetPath(name, assetsRoot)]);
    const outJs = joinAppPath(first.outdir, "index.js");
    const code = readFileSync(outJs, "utf8");
    expect(code).toContain(
      `new URL("/artifacts/${name}/a.data", import.meta.url)`,
    );
    // Nothing placed beside the output.
    expect(readdirSync(first.outdir).sort()).toEqual([
      "index.js",
      "index.js.map",
    ]);
    const entry = packageAssetPath(name, assetsRoot);
    expect(readdirSync(entry).sort()).toEqual([
      "a.data",
      "a.data.br",
      "a.data.gz",
      "meta.json",
    ]);

    // The map still resolves past the literal: the marker's segment points at
    // the marker in the rewritten code, and at the marker in the source.
    const map = JSON.parse(readFileSync(`${outJs}.map`, "utf8")) as {
      mappings: string;
      sourcesContent: string[];
    };
    const lines = code.split("\n");
    const markerLine = lines.findIndex((l) => l.includes('"after-marker"'));
    const cols = columns(map.mappings)[markerLine]!;
    const markerCol = lines[markerLine]!.indexOf('"after-marker"');
    expect(cols).toContain(markerCol);
    const urlLine = lines.findIndex((l) => l.includes("/artifacts/"));
    const urlCols = columns(map.mappings)[urlLine]!;
    for (const c of urlCols) expect(c).toBeLessThan(lines[urlLine]!.length);

    // A second build reuses the published entry.
    const metaBefore = statSync(joinAppPath(entry, "meta.json")).mtimeMs;
    const second = await build(base);
    expect(
      await rewritePackageAssetUrls({
        metafile: second.metafile,
        cwd: base,
        pin,
        assetsRoot,
      }),
    ).toEqual([name]);
    expect(statSync(joinAppPath(entry, "meta.json")).mtimeMs).toBe(metaBefore);
  });
});
