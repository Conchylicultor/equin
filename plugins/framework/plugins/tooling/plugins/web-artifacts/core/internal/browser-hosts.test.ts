import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globRootsOf, hostInputsHash } from "./browser-hosts";

describe("globRootsOf", () => {
  test("a relative pattern's static base resolves against its module", () => {
    expect(
      globRootsOf(
        "/repo",
        "pkg/a/b/server/internal/bundled.ts",
        'const f = import.meta.glob<string>("../../../../data/*.sql", { eager: true });',
      ),
    ).toEqual(["pkg/data"]);
  });

  test("a root-absolute pattern's static base resolves against the repo", () => {
    expect(
      globRootsOf(
        "/repo",
        "pkg/x/server/internal/bundled.ts",
        "import.meta.glob('/config/**/*.jsonc', { query: '?raw' })",
      ),
    ).toEqual(["config"]);
  });

  test("a mention outside a call is not a pattern", () => {
    expect(
      globRootsOf("/repo", "a.ts", "// vite rewrites `import.meta.glob` here"),
    ).toEqual([]);
  });

  test("a non-literal pattern throws, naming the module", () => {
    expect(() =>
      globRootsOf("/repo", "pkg/x/a.ts", "import.meta.glob(PATTERN)"),
    ).toThrow(/pkg\/x\/a\.ts/);
  });

  test("a pattern reaching outside the repo throws", () => {
    expect(() =>
      globRootsOf("/repo", "a.ts", 'import.meta.glob("../outside/*.ts")'),
    ).toThrow(/outside the repo/);
  });
});

describe("hostInputsHash", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "browser-host-inputs-"));
    writeFileSync(join(root, "bun.lock"), "lock");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/host.ts"), "host");
    mkdirSync(join(root, "config/a"), { recursive: true });
    writeFileSync(join(root, "config/a/x.origin.jsonc"), "{}");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const inputs = { files: ["src/host.ts"], globRoots: ["config"] };

  test("a new file in a new subdirectory of a glob root re-addresses the host", () => {
    const before = hostInputsHash(root, inputs, "id");
    mkdirSync(join(root, "config/new"));
    writeFileSync(join(root, "config/new/y.origin.jsonc"), "{}");
    expect(hostInputsHash(root, inputs, "id")).not.toBe(before);
  });

  test("without the glob root the same tree hashes the same", () => {
    const flat = { files: inputs.files, globRoots: [] };
    const before = hostInputsHash(root, flat, "id");
    mkdirSync(join(root, "config/new"));
    expect(hostInputsHash(root, flat, "id")).toBe(before);
  });

  test("a recorded file that is gone is no address", () => {
    rmSync(join(root, "src/host.ts"));
    expect(hostInputsHash(root, inputs, "id")).toBeNull();
  });
});
