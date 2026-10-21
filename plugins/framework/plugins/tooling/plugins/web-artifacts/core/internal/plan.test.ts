import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildImportMap } from "../import-map";
import {
  artifactUrl,
  closureSpecsOf,
  coEntriesFor,
  composeMapEntries,
  eagerWebTargets,
  hostSpecOf,
  planFleet,
  pluginIdOf,
  resolveBarrelClosure,
  servedSpecsOf,
  type PlannedTarget,
} from "./plan";
import type { ArtifactMeta } from "./store";
import type { VendorSetMeta } from "./vendors";

function target(
  partial: Pick<PlannedTarget, "dirName" | "specifier">,
): PlannedTarget {
  return {
    ...partial,
    kind: "web",
    pluginPath: "x",
    entryFile: "/x/web/index.ts",
    inputsHash: "0".repeat(64),
    coEntries: [],
    needsBuild: false,
  };
}

describe("composeMapEntries (the expected-map assembly shared with compose)", () => {
  const vendorMeta: VendorSetMeta = {
    entries: { react: "react.js", "react-dom/client": "react-dom__client.js" },
    imports: {},
    setHash: "f".repeat(64),
  };

  test("targets + registry alias + vendor entries, entry artifact excluded", () => {
    const entries = composeMapEntries({
      targets: [
        target({ dirName: "tasks.web.abc", specifier: "@plugins/tasks/web" }),
        target({ dirName: "tasks.core.def", specifier: "@plugins/tasks/core" }),
        target({ dirName: "web-core.entry.123", specifier: null }), // entry: no map entry
      ],
      registryDirName: "composition-web-registry.registry.999",
      vendorMeta,
      hosts: [],
    });
    const map = buildImportMap(entries).imports;
    expect(map).toEqual({
      "@composition-web-registry":
        "/artifacts/composition-web-registry.registry.999/index.js",
      "@plugins/tasks/core": "/artifacts/tasks.core.def/index.js",
      "@plugins/tasks/web": "/artifacts/tasks.web.abc/index.js",
      react: `/artifacts/set.${"f".repeat(16)}/react.js`,
      "react-dom/client": `/artifacts/set.${"f".repeat(16)}/react-dom__client.js`,
    });
  });

  test("one artifact serves its co-entries from their own files", () => {
    const web = {
      ...target({ dirName: "tasks.web.abc", specifier: "@plugins/tasks/web" }),
      coEntries: [
        {
          folder: "exhibits",
          entryFile: "/x/exhibits/index.ts",
          specifier: "@plugins/tasks/exhibits",
        },
      ],
    };
    const map = buildImportMap(
      composeMapEntries({
        targets: [web],
        registryDirName: "composition-web-registry.registry.999",
        vendorMeta,
        hosts: [],
      }),
    ).imports;
    expect(map["@plugins/tasks/web"]).toBe("/artifacts/tasks.web.abc/index.js");
    expect(map["@plugins/tasks/exhibits"]).toBe(
      "/artifacts/tasks.web.abc/exhibits.js",
    );
    expect(servedSpecsOf([web])).toEqual(
      new Set(["@plugins/tasks/web", "@plugins/tasks/exhibits"]),
    );
  });

  test("map recompute is a pure function of targets — same input, same map", () => {
    const make = () =>
      buildImportMap(
        composeMapEntries({
          targets: [
            target({ dirName: "a.web.1", specifier: "@plugins/a/web" }),
          ],
          registryDirName: "composition-web-registry.registry.2",
          vendorMeta,
          hosts: [],
        }),
      ).imports;
    expect(make()).toEqual(make());
  });
});

describe("closureSpecsOf (which emitted imports extend the barrel closure)", () => {
  const meta = (
    partial: Pick<ArtifactMeta, "staticImportsByFile" | "dynamicImports">,
  ): ArtifactMeta => ({
    specifier: "@plugins/x/web",
    kind: "web",
    pluginPath: "x",
    inputsHash: "0".repeat(64),
    builtAtMs: 0,
    ...partial,
  });

  test("static imports always extend the closure — even browser-unreachable kinds", () => {
    expect(
      closureSpecsOf(
        meta({
          staticImportsByFile: {
            "index.js": ["@plugins/a/core", "@plugins/b/prewarm"],
          },
          dynamicImports: [],
        }),
      ),
    ).toEqual(["@plugins/a/core", "@plugins/b/prewarm"]);
  });

  test("static imports of code-split chunks extend the closure like the entry's", () => {
    expect(
      closureSpecsOf(
        meta({
          staticImportsByFile: {
            "index.js": ["@plugins/a/core"],
            "impl-abc.mjs": ["@plugins/lazy-only/core", "@plugins/a/core"],
          },
          dynamicImports: [],
        }),
      ),
    ).toEqual(["@plugins/a/core", "@plugins/lazy-only/core"]);
  });

  test("dynamic folder-barrel imports extend the closure (lazy artifacts get mapped)", () => {
    expect(
      closureSpecsOf(
        meta({
          staticImportsByFile: {},
          dynamicImports: [
            "@plugins/primitives/plugins/icon-picker/core",
            "@plugins/primitives/plugins/css/plugins/pin/core",
          ],
        }),
      ),
    ).toEqual([
      "@plugins/primitives/plugins/icon-picker/core",
      "@plugins/primitives/plugins/css/plugins/pin/core",
    ]);
  });

  test("dynamic imports of browser-unreachable kinds are exempt (skipped)", () => {
    expect(
      closureSpecsOf(
        meta({
          staticImportsByFile: {
            "index.js": ["@plugins/infra/plugins/asset-mirror/core"],
          },
          dynamicImports: [
            "@plugins/apps/plugins/sonata/plugins/audio/plugins/piano/prewarm",
            "@plugins/primitives/plugins/icon-picker/core",
          ],
        }),
      ),
    ).toEqual([
      "@plugins/infra/plugins/asset-mirror/core",
      "@plugins/primitives/plugins/icon-picker/core",
    ]);
  });
});

describe("eagerWebTargets (the preload-seed selection, a pure membership test)", () => {
  const targets = [
    target({ dirName: "shell.web.1", specifier: "@plugins/shell/web" }),
    target({ dirName: "tasks.web.2", specifier: "@plugins/tasks/web" }),
  ].map((t, i) => ({ ...t, pluginPath: i === 0 ? "shell" : "tasks" }));

  test("filters the deferred paths out of the entry set", () => {
    expect(
      eagerWebTargets(targets, new Set(["tasks"])).map((t) => t.pluginPath),
    ).toEqual(["shell"]);
  });

  test("a deferred superset is exact on the filtered entries (composition source)", () => {
    // The full DEFERRED_PLUGIN_PATHS may name plugins outside a composition's
    // filtered registry — membership filtering must not care.
    expect(
      eagerWebTargets(
        targets,
        new Set(["tasks", "not-in-this-composition"]),
      ).map((t) => t.pluginPath),
    ).toEqual(["shell"]);
  });
});

describe("planFleet with an injected fleet source", () => {
  const repoRoot = join(import.meta.dir, "../".repeat(8));
  const tmp = mkdtempSync(join(tmpdir(), "fleet-source-test-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  test("plans targets from the source's entries and slugs the registry per source", async () => {
    const registryFile = join(tmp, "web.composition.testcomp.generated.ts");
    writeFileSync(registryFile, "export const webEntries = [];\n");

    const deferredPaths = new Set(["some/deferred/path"]);
    const plan = await planFleet({
      root: repoRoot,
      minify: false,
      cache: { version: 1, records: {} },
      source: {
        webEntries: [{ pluginPath: "shell", id: "shell", dependsOn: [] }],
        deferredPaths,
        registryFile,
        registrySlug: "web-registry-testcomp",
      },
    });

    expect(plan.webTargets.map((t) => t.specifier)).toEqual([
      "@plugins/shell/web",
    ]);
    expect(
      plan.registryTarget.dirName.startsWith("web-registry-testcomp.registry."),
    ).toBe(true);
    expect(plan.registryTarget.registryFile).toBe(registryFile);
    expect(plan.deferredPaths).toBe(deferredPaths);
  });

  test("the registry store name is a pure function of source content + slug", async () => {
    const registryFile = join(tmp, "web.composition.other.generated.ts");
    writeFileSync(registryFile, "export const webEntries = [];\n");
    const source = {
      webEntries: [],
      deferredPaths: new Set<string>(),
      registryFile,
      registrySlug: "web-registry-other",
    };
    const opts = { root: repoRoot, minify: false, source };
    const a = await planFleet({ ...opts, cache: { version: 1, records: {} } });
    const b = await planFleet({ ...opts, cache: { version: 1, records: {} } });
    expect(a.registryTarget.dirName).toBe(b.registryTarget.dirName);
    // Same content as testcomp's registry, different slug ⇒ different store dir.
    expect(
      a.registryTarget.dirName.startsWith("web-registry-other.registry."),
    ).toBe(true);
  });
});

describe("plan identity helpers", () => {
  test("pluginIdOf flattens nesting", () => {
    expect(pluginIdOf("framework/plugins/tooling/plugins/web-artifacts")).toBe(
      "framework.tooling.web-artifacts",
    );
  });

  test("artifactUrl shape", () => {
    expect(artifactUrl("tasks.web.abc")).toBe(
      "/artifacts/tasks.web.abc/index.js",
    );
  });
});

describe("co-built folders (exhibits/ is a second entry of the web artifact)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "cobuilt-test-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const barrel = (rel: string, body = "export default 1;\n"): void => {
    mkdirSync(join(tmp, rel, ".."), { recursive: true });
    writeFileSync(join(tmp, rel), body);
  };
  barrel("both/web/index.ts");
  barrel("both/exhibits/index.ts");
  barrel("webonly/web/index.ts");
  barrel("orphan/exhibits/index.ts");

  test("a web target carries one co-entry per co-built barrel present", () => {
    expect(coEntriesFor("web", "both", join(tmp, "both"))).toEqual([
      {
        folder: "exhibits",
        entryFile: join(tmp, "both/exhibits/index.ts"),
        specifier: "@plugins/both/exhibits",
      },
    ]);
    expect(coEntriesFor("web", "webonly", join(tmp, "webonly"))).toEqual([]);
    // Only the host kind carries them.
    expect(coEntriesFor("core", "both", join(tmp, "both"))).toEqual([]);
  });

  test("a co-built specifier names its host's artifact; others name their own", () => {
    expect(hostSpecOf("@plugins/both/exhibits", tmp)).toBe("@plugins/both/web");
    expect(hostSpecOf("@plugins/both/core", tmp)).toBe("@plugins/both/core");
  });

  test("exhibits/ without web/ fails loudly — there is nothing to co-build it into", () => {
    expect(() => hostSpecOf("@plugins/orphan/exhibits", tmp)).toThrow(
      "has exhibits/ without web/",
    );
  });

  test("the closure plans the host web artifact for a dynamic exhibits import — never an exhibits artifact", async () => {
    const seed: ArtifactMeta = {
      specifier: "@plugins/catalog/core",
      kind: "core",
      pluginPath: "catalog",
      inputsHash: "0".repeat(64),
      builtAtMs: 0,
      staticImportsByFile: { "index.js": [] },
      dynamicImports: ["@plugins/both/exhibits"],
    };
    const ensured: PlannedTarget[] = [];
    const closure = await resolveBarrelClosure({
      pluginsRoot: tmp,
      identityHash: "1".repeat(64),
      cache: { version: 1, records: {} },
      servedSpecs: new Set(),
      seedMetas: [seed],
      ensure: (t) => {
        ensured.push(t);
        return Promise.resolve(null);
      },
    });
    expect([...closure.keys()]).toEqual(["@plugins/both/web"]);
    const host = closure.get("@plugins/both/web")!;
    expect(host.kind).toBe("web");
    expect(host.coEntries.map((e) => e.specifier)).toEqual([
      "@plugins/both/exhibits",
    ]);
    expect(ensured.map((t) => t.kind)).toEqual(["web"]);
  });

  test("an exhibits import whose web artifact the fleet already serves adds nothing", async () => {
    const seed: ArtifactMeta = {
      specifier: "@plugins/catalog/core",
      kind: "core",
      pluginPath: "catalog",
      inputsHash: "0".repeat(64),
      builtAtMs: 0,
      staticImportsByFile: { "index.js": [] },
      dynamicImports: ["@plugins/both/exhibits"],
    };
    const closure = await resolveBarrelClosure({
      pluginsRoot: tmp,
      identityHash: "1".repeat(64),
      cache: { version: 1, records: {} },
      servedSpecs: new Set(["@plugins/both/web", "@plugins/both/exhibits"]),
      seedMetas: [seed],
      ensure: () => Promise.resolve(null),
    });
    expect(closure.size).toBe(0);
  });
});
