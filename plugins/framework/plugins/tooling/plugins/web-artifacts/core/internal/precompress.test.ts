import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { precompressDir } from "./precompress";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fresh(): string {
  dir = mkdtempSync(join(tmpdir(), "precompress-"));
  return dir;
}

describe("precompressDir", () => {
  test("writes .br and .gz sidecars that decode to the original, recursively", async () => {
    const root = fresh();
    mkdirSync(join(root, "assets"));
    const js = "export const x = 1;\n".repeat(500);
    writeFileSync(join(root, "index.js"), js);
    writeFileSync(join(root, "assets", "pglite.wasm"), Buffer.alloc(8192, 7));
    await precompressDir(root);
    expect(
      brotliDecompressSync(readFileSync(join(root, "index.js.br"))).toString(),
    ).toBe(js);
    expect(gunzipSync(readFileSync(join(root, "index.js.gz"))).toString()).toBe(
      js,
    );
    expect(existsSync(join(root, "assets", "pglite.wasm.br"))).toBe(true);
    expect(existsSync(join(root, "assets", "pglite.wasm.gz"))).toBe(true);
  });

  test("skips small files, incompressible formats and source maps", async () => {
    const root = fresh();
    writeFileSync(join(root, "tiny.js"), "export {};");
    writeFileSync(join(root, "font.woff2"), Buffer.alloc(8192, 1));
    writeFileSync(join(root, "index.js.map"), "{}".repeat(4096));
    await precompressDir(root);
    for (const f of ["tiny.js", "font.woff2", "index.js.map"]) {
      expect(existsSync(join(root, `${f}.br`))).toBe(false);
      expect(existsSync(join(root, `${f}.gz`))).toBe(false);
    }
  });

  test("writes no sidecar that would not save anything", async () => {
    const root = fresh();
    // Random bytes do not compress.
    writeFileSync(
      join(root, "noise.data"),
      crypto.getRandomValues(new Uint8Array(16384)),
    );
    await precompressDir(root);
    expect(existsSync(join(root, "noise.data.br"))).toBe(false);
    expect(existsSync(join(root, "noise.data.gz"))).toBe(false);
  });
});
