/**
 * The browser-host graph derivation: over the real repo it reproduces the
 * committed demo graph (and takes no negated plugin back but the providers);
 * over fixtures, the rule's failures — a non-portable barrel in the graph's
 * closure (named with its import chain), a service with zero or two
 * providers — throw, and a negated plugin providing nothing the graph declares
 * stays out.
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  asFsPath,
  asPluginId,
} from "@plugins/framework/plugins/plugin-id/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import {
  deriveBrowserHostGraph,
  discoverBrowserHosts,
  renderBrowserHostScope,
  resolveHostGraph,
  type HostClosure,
  type HostGraphInputs,
} from "./browser-host-gen";
import { buildRegistryGenContext } from "./plugin-registry-gen";

setDefaultTimeout(300_000);

const DEMO = "apps/plugins/agent-manager/plugins/demo";

describe("deriveBrowserHostGraph over the repo", () => {
  test("reproduces the committed demo graph, one provider per service", async () => {
    const root = await getWorktreeRoot();
    const ctx = await buildRegistryGenContext(root);
    const host = discoverBrowserHosts(await ctx.repo()).find(
      (h) => h.pluginPath === DEMO,
    );
    expect(host).toBeDefined();
    const graph = await deriveBrowserHostGraph(ctx, host!);
    expect(graph.composition).toBe("agent-manager-demo");

    const committed = readFileSync(join(root, host!.generated), "utf8");
    const entries = [...committed.matchAll(/\{ pluginPath: "([^"]+)"/g)].map(
      (m) => m[1]!,
    );
    expect(graph.members).toEqual(entries);

    // Every provider is a member, and the negated plugins that provide
    // nothing (review/plugin-changes) are not taken back.
    for (const p of Object.values(graph.providers)) {
      expect(graph.members).toContain(p);
    }
    expect(graph.providers["database.migration-source"]).toBe(
      "database/plugins/migrations/plugins/bundled-source",
    );
    expect(
      graph.members.filter((p) =>
        p.startsWith("review/plugins/plugin-changes"),
      ),
    ).toEqual([]);

    // The page side: the composition's home, its web plugins (bundle ∩ web
    // barrels, by dot id, sorted) and what it leaves out.
    expect(graph.home).toBe("agent-manager");
    expect(graph.webPlugins).toEqual([...graph.webPlugins].sort());
    expect(graph.webPlugins).toContain(asPluginId("apps.agent-manager.shell"));
    const repo = await ctx.repo();
    for (const id of graph.webPlugins) {
      expect(repo.has(`plugins/${asFsPath(id)}/web/index.ts`)).toBe(true);
    }
    // A bundled plugin without a web barrel is not a web plugin.
    expect(graph.webPlugins).not.toContain(asPluginId("database"));
    // `available` is the out-of-bundle frontier: disjoint from the web set,
    // sorted, and non-empty (review.code-review soft-contributes to the bundled
    // review pane but is not shipped).
    expect(graph.available).toEqual([...graph.available].sort());
    for (const id of graph.available) {
      expect(graph.webPlugins).not.toContain(id);
    }
    expect(graph.available).toContain(asPluginId("review.code-review"));

    // The page's scope file names exactly the web plugins, the home and the
    // host's own start module.
    const scope = renderBrowserHostScope(host!, graph);
    expect(host!.scopeGenerated).toBe(
      `plugins/${DEMO}/core/browser-host.generated.ts`,
    );
    const listed = [...scope.matchAll(/^ {4}"([^"]+)",$/gm)].map((m) => m[1]!);
    expect(listed).toEqual(graph.webPlugins);
    expect(scope).toContain('  id: "agent-manager-demo",');
    expect(scope).toContain('  home: "agent-manager",');
    expect(scope).toContain(`import("@browser-host/${DEMO}")`);
    expect(scope).toContain("} satisfies DemoHost;");
  });
});

// ── Fixtures ────────────────────────────────────────────────────────────────

// A fixture module under a made-up plugin (`plugins/<plugin>/<rest>`).
const at = (plugin: string, rest: string): string =>
  `plugins/${plugin}/${rest}`;
const barrel = (p: string): string => at(p, "server/index.ts");
const portable = (provides = ""): string =>
  `export default { portable: true, contributions: [${provides}] };`;
const ENTRY = at("host", "bin/browser-host.ts");

/** A fixture repo: files by path, and each module's static closure. */
function inputs(
  files: Record<string, string>,
  closures: Record<string, string[]>,
  over: Partial<HostGraphInputs> = {},
): HostGraphInputs {
  return {
    label: "fixture",
    entry: ENTRY,
    bundleBarrels: [],
    candidateBarrels: [],
    read: async (path) => files[path] ?? null,
    closure: async (entry): Promise<HostClosure> => {
      const modules = new Set([entry, ...(closures[entry] ?? [])]);
      return {
        modules,
        importChain: (m) => (m === entry ? [entry] : [entry, m]),
      };
    },
    ...over,
  };
}

const SERVICE_MODULE = at("db", "server/internal/driver.ts");
const SERVICE = `export const Driver = defineHostService<DriverImpl>("db.driver");`;

/** The rejection's message — `expect(p).rejects` is typed `void` by bun's
 *  matchers, so awaiting it trips `await-thenable`. */
async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected a rejection");
}

describe("resolveHostGraph", () => {
  test("adds the one provider of a declared service, and no other negated plugin", async () => {
    const graph = await resolveHostGraph(
      inputs(
        {
          [ENTRY]: "",
          [barrel("db")]: portable(),
          [SERVICE_MODULE]: SERVICE,
          [barrel("db/plugins/memory")]: portable("Driver.provide(memory)"),
          [barrel("review")]: portable("Unrelated.provide(x)"),
        },
        { [barrel("db")]: [SERVICE_MODULE] },
        {
          bundleBarrels: [barrel("db")],
          candidateBarrels: [barrel("db/plugins/memory"), barrel("review")],
        },
      ),
    );
    expect(graph.members).toEqual(["db", "db/plugins/memory"]);
    expect(graph.providers).toEqual({ "db.driver": "db/plugins/memory" });
  });

  test("the entry's portable imports are roots", async () => {
    const graph = await resolveHostGraph(
      inputs(
        { [ENTRY]: "", [barrel("seeded")]: portable() },
        { [ENTRY]: [barrel("seeded")] },
      ),
    );
    expect(graph.members).toEqual(["seeded"]);
  });

  test("a non-portable barrel in the closure throws, naming the chain", async () => {
    const run = resolveHostGraph(
      inputs(
        {
          [ENTRY]: "",
          [barrel("app")]: portable(),
          [barrel("disk")]: "export default { contributions: [] };",
        },
        { [barrel("app")]: [barrel("disk")] },
        { bundleBarrels: [barrel("app"), barrel("disk")] },
      ),
    );
    expect(await rejection(run)).toContain(
      `the graph loads ${barrel("disk")}, which is not in it (not portable)\n      via ${barrel("app")} → ${barrel("disk")}`,
    );
  });

  test("a declared service with no provider throws", async () => {
    const run = resolveHostGraph(
      inputs(
        { [ENTRY]: "", [barrel("db")]: portable(), [SERVICE_MODULE]: SERVICE },
        { [barrel("db")]: [SERVICE_MODULE] },
        { bundleBarrels: [barrel("db")] },
      ),
    );
    expect(await rejection(run)).toContain(
      `host service "db.driver" (${SERVICE_MODULE}) has no provider`,
    );
  });

  test("a declared service with two providers throws, naming both", async () => {
    const run = resolveHostGraph(
      inputs(
        {
          [ENTRY]: "",
          [barrel("db")]: portable(),
          [SERVICE_MODULE]: SERVICE,
          [barrel("db/plugins/a")]: portable("Driver.provide(a)"),
          [barrel("db/plugins/b")]: portable("Driver.provide(b)"),
        },
        { [barrel("db")]: [SERVICE_MODULE] },
        {
          bundleBarrels: [barrel("db")],
          candidateBarrels: [barrel("db/plugins/a"), barrel("db/plugins/b")],
        },
      ),
    );
    expect(await rejection(run)).toContain(
      `host service "db.driver" has 2 providers: db/plugins/a, db/plugins/b`,
    );
  });
});
