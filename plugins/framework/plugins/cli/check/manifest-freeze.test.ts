import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { callsFunction, measureManifestFreeze } from "./manifest-freeze";
import {
  type AppPath,
  asAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

/**
 * A miniature CLI with the real one's shape: a bootstrap that dynamically
 * imports the program, a registry of declaration loaders, declarations that
 * defer their bodies through `run: () => import(…)`, a manifest registry writer,
 * a pipeline that calls it, and a barrel that re-exports that pipeline next to
 * an unrelated helper (the way `codegen/core` re-exports `regen-pipeline.ts`).
 *
 * `build` regenerates; `deploy` only reads the barrel's other helper. Each test
 * adds ONE import of the manifest somewhere and asserts which closure, if any,
 * is charged for it.
 */
const BASE: Record<string, string> = {
  "tsconfig.base.json": JSON.stringify({
    compilerOptions: { paths: { "@fx/*": ["./*"] } },
  }),
  "bin/index.ts": `await import("./cli");\n`,
  "bin/cli.ts": `import { entries } from "./registry";\nfor (const load of entries) await load();\n`,
  "bin/registry.ts":
    `export const entries = [\n` +
    `  () => import("../cmds/build/index"),\n` +
    `  () => import("../cmds/deploy/index"),\n` +
    `];\n`,
  "define.ts": `export function defineCliCommand<T>(spec: T): T { return spec; }\n`,
  "cmds/build/index.ts":
    `import { defineCliCommand } from "../../define";\n` +
    `export default defineCliCommand({ name: "build", description: "", run: () => import("./run") });\n`,
  "cmds/build/run.ts":
    `import { regenerate } from "../../codegen";\n` +
    `export default async () => { regenerate(); };\n`,
  "cmds/deploy/index.ts":
    `import { defineCliCommand } from "../../define";\n` +
    `export default defineCliCommand({\n` +
    `  name: "deploy",\n` +
    `  description: "",\n` +
    `  subcommands: [defineCliCommand({ name: "converge", description: "", run: () => import("./converge") })],\n` +
    `});\n`,
  "cmds/deploy/converge.ts":
    `import { helper } from "../../codegen";\n` +
    `export default async () => { helper(); };\n`,
  // The barrel: a reader of `helper` LOADS the pipeline module, but only a
  // caller of `regenerate` keeps it live.
  "codegen.ts": `export { regenerate } from "./pipeline";\nexport { helper } from "./helper";\n`,
  "helper.ts": `export function helper(): number { return 1; }\n`,
  "pipeline.ts":
    `import { writeManifest } from "./registry-writer";\n` +
    `export function regenerate(): void { writeManifest("m"); }\n`,
  "registry-writer.ts": `export function writeManifest(id: string): void { (globalThis as Record<string, unknown>).last = id; }\n`,
  // Side-effect imports only, like `fieldsEager`: no code of its own, so it is
  // absent from the tree-shaken set and visible only in the loaded one.
  "manifest.generated.ts": `import "./capability";\n`,
  "capability.ts": `(globalThis as Record<string, unknown>).registered = true;\n`,
  // A stage-1 registry and its reader, which loads it at the first call.
  "lint.generated.ts": `export const lintEntries = [];\n`,
  "lint-reader.ts": `export async function lintEntries() { return (await import("./lint.generated")).lintEntries; }\n`,
};

const MANIFEST = "manifest.generated.ts";
const REGISTRY = "lint.generated.ts";

const roots: AppPath[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function fixture(overrides: Record<string, string> = {}): AppPath {
  const root = asAppPath(mkdtempSync(join(tmpdir(), "manifest-freeze-fx-")));
  roots.push(root);
  for (const [rel, content] of Object.entries({ ...BASE, ...overrides })) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

function measure(root: AppPath) {
  return measureManifestFreeze({
    root,
    entry: "bin/index.ts",
    hazards: new Map([[MANIFEST, "fx"]]),
    registries: new Map([[REGISTRY, "lint"]]),
    startupRoots: ["bin/index.ts", "bin/cli.ts"],
    writer: "writeManifest",
  });
}

/**
 * Await `p` and return the Error it rejected with; throw if it resolved.
 * `expect(p).rejects.toThrow()` is typed `void` under bun:test (the same helper
 * the op-runtime, spawn and host-semaphore suites carry).
 */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

/** The single element of `items`, failing the test when there is not exactly one. */
function only<T>(items: readonly T[]): T {
  const [first, ...rest] = items;
  if (first === undefined || rest.length > 0) {
    throw new Error(`expected exactly one element, got ${items.length}`);
  }
  return first;
}

/** Prepend a bare import of the manifest to one fixture file. */
function withManifestImport(
  file: string,
  from: string,
): Record<string, string> {
  return { [file]: `import "${from}";\n${BASE[file]}` };
}

describe("measureManifestFreeze", () => {
  test("a clean tree passes, and only the command that calls the writer regenerates", async () => {
    const report = await measure(fixture());
    expect(report.findings).toEqual([]);
    expect(report.regenerating).toEqual(["build"]);
  });

  test("a manifest reached from a DECLARATION fails as the startup closure", async () => {
    const report = await measure(
      fixture(
        withManifestImport("cmds/deploy/index.ts", "../../manifest.generated"),
      ),
    );
    const finding = only(report.findings);
    expect(finding.closure).toEqual({ kind: "startup", entry: "bin/index.ts" });
    expect(only(finding.manifests)).toMatchObject({ path: MANIFEST, id: "fx" });
    expect(only(finding.manifests).chain).toEqual([
      "bin/index.ts",
      "bin/cli.ts",
      "bin/registry.ts",
      "cmds/deploy/index.ts",
      MANIFEST,
    ]);
  });

  test("a manifest reached only from a NON-regenerating command's run passes", async () => {
    // `deploy converge` loads the manifest AND loads the pipeline module (via
    // the barrel), but never references `regenerate`: not a regenerator.
    const report = await measure(
      fixture(
        withManifestImport(
          "cmds/deploy/converge.ts",
          "../../manifest.generated",
        ),
      ),
    );
    expect(report.findings).toEqual([]);
    expect(report.regenerating).toEqual(["build"]);
  });

  test("a manifest reached from a REGENERATING command's run fails, naming the command", async () => {
    const report = await measure(
      fixture(
        withManifestImport("cmds/build/run.ts", "../../manifest.generated"),
      ),
    );
    const finding = only(report.findings);
    expect(finding.closure).toEqual({
      kind: "command-run",
      commands: ["build"],
      target: "cmds/build/run.ts",
      regenerators: ["pipeline.ts"],
    });
    expect(only(finding.manifests).chain).toEqual([
      "cmds/build/run.ts",
      MANIFEST,
    ]);
  });

  test("a command that reaches the writer through a DYNAMIC edge still regenerates", async () => {
    const report = await measure(
      fixture({
        "cmds/deploy/converge.ts":
          `import "../../manifest.generated";\n` +
          `export default async () => { (await import("../../codegen")).regenerate(); };\n`,
      }),
    );
    expect(report.regenerating).toEqual(["build", "deploy converge"]);
    expect(report.findings.map((f) => f.closure.kind)).toEqual(["command-run"]);
  });

  test("a run thunk in a non-canonical shape is followed, so its body is charged to startup", async () => {
    const report = await measure(
      fixture({
        "cmds/deploy/index.ts":
          `import { defineCliCommand } from "../../define";\n` +
          `export default defineCliCommand({ name: "deploy", description: "", run: () => { return import("./converge"); } });\n`,
        ...withManifestImport(
          "cmds/deploy/converge.ts",
          "../../manifest.generated",
        ),
      }),
    );
    expect(report.findings.map((f) => f.closure.kind)).toEqual(["startup"]);
  });

  test("a registry evaluated at a REGENERATING command's load fails", async () => {
    const report = await measure(
      fixture(withManifestImport("cmds/build/run.ts", "../../lint.generated")),
    );
    const finding = only(report.findings);
    expect(finding.closure.kind).toBe("command-run");
    expect(only(finding.manifests)).toMatchObject({
      path: REGISTRY,
      id: "lint",
      hazard: "registry",
      chain: ["cmds/build/run.ts", REGISTRY],
    });
  });

  test("a registry evaluated by a DECLARATION fails as the startup closure", async () => {
    const report = await measure(
      fixture(
        withManifestImport("cmds/deploy/index.ts", "../../lint.generated"),
      ),
    );
    const finding = only(report.findings);
    expect(finding.closure.kind).toBe("startup");
    expect(only(finding.manifests)).toMatchObject({
      path: REGISTRY,
      hazard: "registry",
    });
  });

  test("a registry a regenerating command reads through an import() at the call passes", async () => {
    // Unlike a manifest, a registry's reader may sit in the closure: stage 1
    // runs before the call evaluates it.
    const report = await measure(
      fixture({
        "cmds/build/run.ts":
          `import { regenerate } from "../../codegen";\n` +
          `import { lintEntries } from "../../lint-reader";\n` +
          `export default async () => { regenerate(); await lintEntries(); };\n`,
      }),
    );
    expect(report.findings).toEqual([]);
  });

  test("throws rather than passing when no command regenerates", async () => {
    const root = fixture({
      "pipeline.ts": `export function regenerate(): void {}\n`,
    });
    expect((await rejection(measure(root))).message).toContain(
      "No command's run closure",
    );
  });
});

describe("callsFunction", () => {
  test("a call counts; a definition, a re-export and a comment do not", async () => {
    expect(
      await callsFunction("a.ts", `writeManifest(m, root);`, "writeManifest"),
    ).toBe(true);
    expect(
      await callsFunction("a.ts", `codegen.writeManifest(m);`, "writeManifest"),
    ).toBe(true);
    expect(
      await callsFunction(
        "a.ts",
        `export function writeManifest(m) {}\nexport { writeManifest as w } from "./x";\n// writeManifest(m)\n`,
        "writeManifest",
      ),
    ).toBe(false);
  });
});
