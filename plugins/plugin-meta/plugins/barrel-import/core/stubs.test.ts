import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { importBarrel, registerBarrelStubs } from "./internal/stubs";

// React loads for real under the barrel stubs (see registerBarrelStubs). A
// hand-kept React export list broke the build whenever web code imported a
// name it lacked; this fixture imports several such names, so reintroducing a
// React stub fails here instead of in codegen.
describe("registerBarrelStubs", () => {
  test("a barrel importing any real React / react-dom export loads", async () => {
    registerBarrelStubs(REPO_ROOT);
    const mod = await importBarrel(
      resolve(import.meta.dir, "testing/react-exports-fixture.ts"),
    );
    const seen = mod.reactExportsSeen as Record<string, unknown>;
    for (const name of [
      "use",
      "useActionState",
      "useInsertionEffect",
      "useOptimistic",
      "preload",
    ]) {
      expect(typeof seen[name]).toBe("function");
    }
  });
});
