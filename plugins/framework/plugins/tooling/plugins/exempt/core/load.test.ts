/**
 * `loadExemptions` reads the manifests the file set holds — no registry — so
 * a manifest's set is whatever is on disk at the moment of the load.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { exemptManifestPaths, loadExemptions } from "./load";

let root = "";

function write(rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

const manifest = (rule: string): string =>
  `export default [{ rule: "${rule}", paths: ["."], kind: "sanctioned", reason: "r" }];\n`;

/** A source over `paths`; its glob answers every path, as a superset may. */
const source = (paths: string[]) => ({ root, glob: () => paths });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "exempt-load-"));
  write("plugins/primitives/exempt/index.ts", manifest("ns/one"));
  write(
    "plugins/primitives/plugins/networking/exempt/index.ts",
    manifest("ns/two"),
  );
  write("plugins/primitives/web/exempt/index.ts", manifest("ns/decoy"));
  write("plugins/packages/exempt/index.ts", "export default 42;\n");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("exemptManifestPaths", () => {
  it("keeps only plugin manifests out of a superset glob answer", () => {
    expect(
      exemptManifestPaths(
        source([
          "plugins/primitives/exempt/index.ts",
          "plugins/primitives/plugins/networking/exempt/index.ts",
          "plugins/primitives/web/exempt/index.ts",
          "plugins/primitives/exempt/other.ts",
          "exempt/index.ts",
        ]),
      ),
    ).toEqual([
      "plugins/primitives/exempt/index.ts",
      "plugins/primitives/plugins/networking/exempt/index.ts",
    ]);
  });
});

describe("loadExemptions", () => {
  it("loads every manifest in the file set, nested plugins included", async () => {
    const loaded = await loadExemptions(
      source([
        "plugins/primitives/exempt/index.ts",
        "plugins/primitives/plugins/networking/exempt/index.ts",
        "plugins/primitives/web/exempt/index.ts",
      ]),
    );
    expect(loaded.map((e) => [e.plugin, e.rule])).toEqual([
      ["primitives", "ns/one"],
      ["primitives/plugins/networking", "ns/two"],
    ]);
  });

  it("a manifest gone from the file set is simply not loaded", async () => {
    const loaded = await loadExemptions(
      source(["plugins/primitives/exempt/index.ts"]),
    );
    expect(loaded.map((e) => e.rule)).toEqual(["ns/one"]);
  });

  it("names an invalid manifest", async () => {
    let message = "";
    try {
      await loadExemptions(source(["plugins/packages/exempt/index.ts"]));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("plugins/packages/exempt/index.ts");
  });
});
