import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { readFileSync as timedReadFileSync } from "@plugins/packages/plugins/timed-fs/core";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { barrelLoadInputs, BarrelLoadReadError } from "./internal/load-guard";
import { importBarrel, registerBarrelStubs } from "./internal/stubs";

// Each fixture is a module written to a temp dir (never a repo file: a module
// that reads its host at load is what the guard exists to keep out of the
// tree), importing timed-fs by its absolute path.
const dir = realpathSync(mkdtempSync(join(tmpdir(), "load-guard-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const TIMED_FS = resolve(
  REPO_ROOT,
  "plugins/packages/plugins/timed-fs/core/index.ts",
);
let n = 0;
function fixture(body: string): string {
  const file = join(dir, `fixture-${++n}.ts`);
  writeFileSync(
    file,
    `import { readFileSync } from ${JSON.stringify(TIMED_FS)};\nvoid readFileSync;\n${body}\n`,
  );
  return file;
}

const F = [
  "export const v = process.env.LOAD_GUARD_TEST_VAR;",
  `export const v = readFileSync(${JSON.stringify(TIMED_FS)}, "utf8");`,
  "export const v = process.cwd();",
  "export const v = Object.keys(process.env);",
  "process.env.LOAD_GUARD_TEST_WRITE = '1';\nexport const v = process.env.NODE_ENV ?? 'unset';",
  "export const home = () => process.env.LOAD_GUARD_TEST_VAR;",
  "export const v = 1;",
  "let caught: unknown;\ntry { void process.env.LOAD_GUARD_TEST_VAR; } catch (e) { caught = e; }\nexport const name = (caught as Error | undefined)?.name;",
  "await Promise.resolve();\nexport const v = 1;",
].map(fixture);

process.env.LOAD_GUARD_TEST_VAR = "set";
registerBarrelStubs(REPO_ROOT);

describe("a barrel's load", () => {
  test("refuses an environment read at module top level, naming the variable", () => {
    const file = F[0]!;
    expect(importBarrel(file)).rejects.toThrow(
      /process\.env\.LOAD_GUARD_TEST_VAR was read by .*fixture-\d+\.ts/,
    );
  });

  test("refuses a file read at module top level", () => {
    const file = F[1]!;
    expect(importBarrel(file)).rejects.toThrow(/readFileSync\(.*\) was called/);
  });

  test("refuses a working-directory read and an environment listing", () => {
    expect(importBarrel(F[2]!)).rejects.toThrow(/process\.cwd\(\) was read/);
    expect(importBarrel(F[3]!)).rejects.toThrow(/process\.env was listed/);
  });

  test("lets a declared load input through, and a write", async () => {
    const mod = await importBarrel(F[4]!);
    expect(mod.v).toBe(process.env.NODE_ENV ?? "unset");
    expect(process.env.LOAD_GUARD_TEST_WRITE).toBe("1");
  });

  test("lets a read made at run time through: the span holds only top-level code", async () => {
    const mod = await importBarrel(F[5]!);
    expect((mod.home as () => string | undefined)()).toBe(
      process.env.LOAD_GUARD_TEST_VAR,
    );
    // And the guard is gone once the import settled, refused or not.
    expect(process.env.LOAD_GUARD_TEST_VAR).toBeDefined();
    expect(process.cwd()).toBeTruthy();
    expect(timedReadFileSync(TIMED_FS, "utf8")).toContain("timed-fs");
  });

  test("never charges a concurrent caller's read to the barrel being loaded", async () => {
    const reads: (string | undefined)[] = [];
    let loading = true;
    const concurrent = (async () => {
      while (loading) {
        reads.push(process.env.LOAD_GUARD_TEST_VAR);
        await new Promise((r) => setTimeout(r, 0));
      }
    })();
    await importBarrel(F[6]!);
    loading = false;
    await concurrent;
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((r) => r === process.env.LOAD_GUARD_TEST_VAR)).toBe(
      true,
    );
  });

  test("the refusal is a BarrelLoadReadError at the read", () => {
    const file = F[7]!;
    return importBarrel(file).then((mod) =>
      expect(mod.name).toBe(new BarrelLoadReadError("").name),
    );
  });
});

test("a top-level await closes the span instead of holding it open over other code", async () => {
  await importBarrel(F[8]!);
  expect(process.env.LOAD_GUARD_TEST_VAR).toBe("set");
});

test("a barrel written after its folder was first read still loads", async () => {
  // Bun's resolver caches a folder's entries once it has read them; the
  // wrapper's static import must not answer from that cache.
  await importBarrel(F[6]!);
  const late = fixture("export const late = 42;");
  expect((await importBarrel(late)).late).toBe(42);
});

describe("barrelLoadInputs", () => {
  test("names every declared input, one name=value each", () => {
    const inputs = barrelLoadInputs();
    expect(inputs).toContain(`NODE_ENV=${process.env.NODE_ENV ?? ""}`);
    expect(inputs.some((i) => i.startsWith("dataRoot=/"))).toBe(true);
    expect(inputs.every((i) => i.includes("="))).toBe(true);
  });
});
