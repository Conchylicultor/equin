/**
 * Unit tests for the PURE core of the eager-tier generator (`computeEagerTier`),
 * the structural predicate (`isAppContent`), and the per-file preloaded key
 * scan (`preloadedKeysIn`), driven by synthetic inputs — no filesystem. Covers: the structural rule, watched-slot pins, preload pins,
 * the reachability throw, the dependsOn closure pulling a dep of an eager shell
 * out of deferral, and deterministic sorted output — and the scan over a file
 * set (which files it reads). Run with `bun test`.
 */

import { test, expect, describe } from "bun:test";
import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import type { RepoFiles } from "@plugins/framework/plugins/tooling/core";
import { classifyEdges } from "@plugins/plugin-meta/plugins/closure/core";
import type { PluginNode } from "@plugins/plugin-meta/plugins/plugin-tree/core";
import {
  preloadedKeysIn,
  computeEagerTier,
  isAppContent,
  renderEagerTierManifest,
} from "./eager-tier-gen";
import type { RegistryGenContext } from "./plugin-registry-gen";

describe("isAppContent", () => {
  test("app content = apps/plugins/<app>/plugins/<child> with child !== shell", () => {
    expect(isAppContent("apps/plugins/sonata/plugins/notation")).toBe(true);
    expect(isAppContent("apps/plugins/sonata/plugins/notation/plugins/x")).toBe(
      true,
    );
  });

  test("shell subtree is NOT app content", () => {
    expect(isAppContent("apps/plugins/sonata/plugins/shell")).toBe(false);
    expect(isAppContent("apps/plugins/sonata/plugins/shell/plugins/x")).toBe(
      false,
    );
  });

  test("app umbrella and non-apps plugins are NOT app content", () => {
    expect(isAppContent("apps/plugins/sonata")).toBe(false);
    expect(isAppContent("conversations")).toBe(false);
    expect(isAppContent("primitives/plugins/pane")).toBe(false);
  });
});

const noDeps = new Map<string, string[]>();

describe("computeEagerTier", () => {
  test("structural rule: non-app-content eager, plain app content defers", () => {
    const { deferred } = computeEagerTier({
      webEntryPaths: [
        "conversations",
        "apps/plugins/sonata/plugins/shell",
        "apps/plugins/sonata/plugins/notation",
      ],
      deps: noDeps,
      preloadOwners: [],
      watchedSlotHits: [],
    });
    expect(deferred).toEqual(["apps/plugins/sonata/plugins/notation"]);
  });

  test("watched-slot hit pins an app-content plugin eager", () => {
    const { deferred, appContentPins } = computeEagerTier({
      webEntryPaths: [
        "apps/plugins/agent-manager/plugins/shell",
        "apps/plugins/agent-manager/plugins/worktree-switcher",
      ],
      deps: noDeps,
      preloadOwners: [],
      watchedSlotHits: [
        {
          path: "apps/plugins/agent-manager/plugins/worktree-switcher",
          slot: "ActionBar.Item",
        },
      ],
    });
    expect(deferred).toEqual([]);
    expect(appContentPins).toEqual([
      {
        path: "apps/plugins/agent-manager/plugins/worktree-switcher",
        reason: "watched boot slot ActionBar.Item",
      },
    ]);
  });

  test("a preloaded descriptor pins its owning plugin eager", () => {
    const { deferred, appContentPins } = computeEagerTier({
      // A top-level (non-app-content) owner — eager anyway, but annotated nowhere
      // (only app-content pins are listed). Use an app-content owner to see a pin.
      webEntryPaths: ["apps/plugins/mail/plugins/sync"],
      deps: noDeps,
      preloadOwners: [
        { path: "apps/plugins/mail/plugins/sync", keys: ["mailSync"] },
      ],
      watchedSlotHits: [],
    });
    expect(deferred).toEqual([]);
    expect(appContentPins).toEqual([
      {
        path: "apps/plugins/mail/plugins/sync",
        reason: "preloaded descriptor (mailSync)",
      },
    ]);
  });

  test("reachability: a preloaded owner with no web entry throws with the fix", () => {
    expect(() =>
      computeEagerTier({
        webEntryPaths: ["conversations"],
        deps: noDeps,
        preloadOwners: [
          { path: "tasks/plugins/tasks-core", keys: ["tasks", "attempts"] },
        ],
        watchedSlotHits: [],
      }),
    ).toThrow(/tasks\/plugins\/tasks-core/);
  });

  test("closure: a dep of an eager shell is pulled out of deferral", () => {
    const { deferred, appContentPins } = computeEagerTier({
      webEntryPaths: [
        "apps/plugins/sonata/plugins/shell", // eager (structural)
        "apps/plugins/sonata/plugins/voicing", // app content, only reached via shell
        "apps/plugins/sonata/plugins/notation", // app content, unreferenced
      ],
      // shell imports voicing (forward edge shell → voicing).
      deps: new Map([
        [
          "apps/plugins/sonata/plugins/shell",
          ["apps/plugins/sonata/plugins/voicing"],
        ],
      ]),
      preloadOwners: [],
      watchedSlotHits: [],
    });
    expect(deferred).toEqual(["apps/plugins/sonata/plugins/notation"]);
    expect(appContentPins).toEqual([
      {
        path: "apps/plugins/sonata/plugins/voicing",
        reason: "dependency closure (imported by an eager plugin)",
      },
    ]);
  });

  test("deterministic: deferred + pins are sorted regardless of input order", () => {
    const { deferred, appContentPins } = computeEagerTier({
      webEntryPaths: [
        "apps/plugins/z/plugins/b",
        "apps/plugins/a/plugins/y",
        "apps/plugins/a/plugins/x",
      ],
      deps: noDeps,
      preloadOwners: [{ path: "apps/plugins/a/plugins/x", keys: ["k"] }],
      watchedSlotHits: [
        { path: "apps/plugins/a/plugins/y", slot: "Core.Root" },
      ],
    });
    expect(deferred).toEqual(["apps/plugins/z/plugins/b"]);
    expect(appContentPins).toEqual([
      {
        path: "apps/plugins/a/plugins/x",
        reason: "preloaded descriptor (k)",
      },
      {
        path: "apps/plugins/a/plugins/y",
        reason: "watched boot slot Core.Root",
      },
    ]);
  });
});

const NOT_OWNER = { ownerPlugin: false };

describe("preloadedKeysIn", () => {
  test("a vocabulary owner's wrapper call is not a declaration site; the same call elsewhere throws", () => {
    // A wrapper forwarding a literal preload flag to a factory under a
    // computed key — the shape of a vocabulary owner implementing one.
    const src = `
      const descriptor = liveValue(key, {
        schema: z.array(rowSchema),
        preload: "boot",
      });
    `;
    expect(
      preloadedKeysIn(src, "descriptor.ts", { ownerPlugin: true }),
    ).toEqual([]);
    expect(() => preloadedKeysIn(src, "descriptor.ts", NOT_OWNER)).toThrow(
      /descriptor\.ts:2: liveValue/,
    );
  });

  test("reads a preloaded key from every descriptor factory", () => {
    // A factory missing from the list is the case this scanner was blind to: it
    // kept its own four-name list and the bounded factories were never added, so
    // a preloaded resource under `apps/plugins/**` silently stayed deferred.
    const src = `
      export const unread = liveValue("unread", { schema: S, preload: "boot-and-keep" });
      export const tasks = liveCollection("tasks", {
        row: S, id: "id",
        all: { orderBy: [["rank", "asc"]], unbounded: { reason: "the task tree" } },
        preload: "boot",
      });
      export const quiet = liveValue("quiet", { schema: S });
      export const off = liveValue("off", { schema: S, preload: "none" });
    `;
    expect(preloadedKeysIn(src, "a.ts", NOT_OWNER)).toEqual([
      "unread",
      "tasks",
    ]);
  });

  test("a collection's preload marks its window only, never :rows or :groups", () => {
    const src = `
      export const notifications = liveCollection("notifications", {
        row: S, id: "id", filterable: {}, sortable: ["createdAt"],
        default: { orderBy: [["createdAt", "desc"]], limit: 200 }, maxLimit: 500,
        preload: "boot",
      });
      export const sources = liveCollection("events.sources", {
        row: S, id: "id", filterable: {}, sortable: ["name"],
        default: { orderBy: [["name", "asc"]], limit: 100 }, maxLimit: 500,
      });
      export const lazy = liveCollection("lazy", {
        row: S, id: "id", filterable: {}, sortable: ["name"],
        default: { orderBy: [["name", "asc"]], limit: 1 }, maxLimit: 2,
        preload: "none",
      });
    `;
    expect(preloadedKeysIn(src, "c.ts", NOT_OWNER)).toEqual(["notifications"]);
  });

  test("an `all` collection's preload marks its key once — never :rows", () => {
    const src = `
      export const tasks = liveCollection("tasks", {
        row: S, id: "id",
        all: { orderBy: [["rank", "asc"]], unbounded: { reason: "the task tree" } },
        preload: "boot",
      });
    `;
    expect(preloadedKeysIn(src, "t.ts", NOT_OWNER)).toEqual(["tasks"]);
  });

  test("throws on a collection whose spec sets both `default` and `all` (A28)", () => {
    const src = `export const c = liveCollection("c", { row: S, id: "id", default: { orderBy: [["n", "asc"]], limit: 1 }, all: { orderBy: [["n", "asc"]], unbounded: { reason: "r" } }, preload: "boot" });`;
    expect(() => preloadedKeysIn(src, "c.ts", NOT_OWNER)).toThrow(
      /c\.ts:1: one declaration mints the key suffix "" twice/,
    );
  });

  test("throws on a collection whose spec is not inline — its `preload:` is hidden too", () => {
    const src = `
      const spec = { row: S, id: "id", all: { orderBy: [["n", "asc"]], unbounded: { reason: "r" } }, preload: "boot" };
      export const c = liveCollection("c", spec);
    `;
    expect(() => preloadedKeysIn(src, "c.ts", NOT_OWNER)).toThrow(
      /c\.ts:3: the spec \(`spec`\) is not an inline object literal/,
    );
  });

  test('a liveValue\'s preload marks its one key; "none" and a parameterized value do not', () => {
    const src = `
      export const unread = liveValue("notifications.unread", {
        schema: UnreadSchema,
        preload: "boot",
      });
      export const kept = liveValue("sentinel.status", { schema: S, preload: "boot-and-keep" });
      export const lazy = liveValue("lazy", { schema: S, preload: "none" });
      export const detail = liveValue("task-detail", { schema: S, params: ["id"] });
    `;
    expect(preloadedKeysIn(src, "v.ts", NOT_OWNER)).toEqual([
      "notifications.unread",
      "sentinel.status",
    ]);
  });

  test("throws on a preload literal that is not a spelling", () => {
    const src = `export const v = liveValue("v", { schema: S, preload: "eager" });`;
    expect(() => preloadedKeysIn(src, "v.ts", NOT_OWNER)).toThrow(
      /v\.ts:1: liveValue\(…\) `preload: "eager"` is not a preload spelling/,
    );
  });

  test("throws on a liveValue whose preload is not a literal", () => {
    const value = `export const v = liveValue("v", { schema: S, preload: mode });`;
    expect(() => preloadedKeysIn(value, "v.ts", NOT_OWNER)).toThrow(
      /v\.ts:1: liveValue\(…\) `preload:` is not a static string literal — got `mode`/,
    );
  });

  test("throws on a collection whose preload is not a literal", () => {
    const src = `export const c = liveCollection("c", { row: S, id: "id", preload: mode });`;
    expect(() => preloadedKeysIn(src, "c.ts", NOT_OWNER)).toThrow(
      /c\.ts:1: liveCollection\(…\) `preload:` is not a static string literal — got `mode`/,
    );
  });

  test("a factory's own declaration is not a preloaded call", () => {
    // `spec: { …; preload?: ResourcePreload }` is a type position — `preload?:`
    // is not the `preload:` field the scan reads.
    const src = `
      export function liveValue<T>(
        key: string,
        spec: { schema: ZodParser<T>; preload?: ResourcePreload },
      ): LiveValue<T> { return d; }
    `;
    expect(preloadedKeysIn(src, "descriptor.ts", NOT_OWNER)).toEqual([]);
  });

  test("throws on a preloaded declaration whose key is not a literal", () => {
    const src = `export const r = liveValue(RESOURCE_KEY, { schema: S, preload: "boot" });`;
    expect(() => preloadedKeysIn(src, "r.ts", NOT_OWNER)).toThrow(
      /r\.ts:1: liveValue/,
    );
    expect(() => preloadedKeysIn(src, "r.ts", NOT_OWNER)).toThrow(
      /RESOURCE_KEY/,
    );
  });

  test("ignores a factory call written inside a string or comment", () => {
    const src = `
      // export const x = liveValue("commented", { schema: S, preload: "boot" });
      const label = "liveValue(\\"fake\\", { schema: S, preload: \\"boot\\" })";
    `;
    expect(preloadedKeysIn(src, "s.ts", NOT_OWNER)).toEqual([]);
  });
});

/** A `RepoFiles` over an in-memory `{ path: text }` map. */
function memRepo(root: string, files: Record<string, string>): RepoFiles {
  const paths = Object.keys(files).sort();
  return {
    root,
    all: () => paths,
    has: (p) => Object.hasOwn(files, p),
    under: (dir) =>
      dir === "" ? paths : paths.filter((p) => p.startsWith(`${dir}/`)),
    read: (p) => Promise.resolve(Object.hasOwn(files, p) ? files[p]! : null),
  };
}

function node(pluginsRoot: string, path: string): PluginNode {
  return {
    dir: `${pluginsRoot}/${path}`,
    path,
    name: path.split("/").at(-1)!,
    id: asPluginId(
      path
        .split("/")
        .filter((s) => s !== "plugins")
        .join("."),
    ),
    descriptions: {},
    loadBearing: false,
    collapsed: false,
    compositionRoot: false,
    runtimes: { web: true, server: false, central: false },
    children: [],
    facets: {},
  };
}

describe("the scan over a file set", () => {
  const WEB_ENTRY = "export default {};\n";
  const CALLS_CORE_ROOT = [
    'import { Core } from "@plugins/framework/plugins/web-sdk/core";',
    "export const root = Core.Root({ component: () => null });",
  ].join("\n");
  const APP = "apps/plugins/mail/plugins";

  async function render(files: Record<string, string>, paths: string[]) {
    const root = "/fixture";
    const repo = memRepo(root, files);
    const nodes = paths.map((p) => node(`${root}/plugins`, p));
    const tree = {
      pluginsRoot: `${root}/plugins`,
      byDir: new Map(nodes.map((n) => [n.dir, n])),
      byPath: new Map(nodes.map((n) => [n.path, n])),
      roots: nodes,
      facets: [],
    };
    const ctx: RegistryGenContext = {
      root,
      tree,
      graph: classifyEdges(tree),
      mainBundle: new Set(nodes.map((n) => n.id)),
      repo: () => Promise.resolve(repo),
      dirScans: new Map(),
    };
    return await renderEagerTierManifest(root, ctx);
  }

  test("a watched slot in a plugin's source pins it; the same call in a test does not", async () => {
    const manifest = await render(
      {
        [`plugins/${APP}/badge/web/index.ts`]: WEB_ENTRY,
        [`plugins/${APP}/badge/web/root.ts`]: CALLS_CORE_ROOT,
        [`plugins/${APP}/quiet/web/index.ts`]: WEB_ENTRY,
        [`plugins/${APP}/quiet/web/root.test.ts`]: CALLS_CORE_ROOT,
        [`plugins/${APP}/quiet/web/__tests__/root.tsx`]: CALLS_CORE_ROOT,
        [`plugins/${APP}/quiet/web/plugins/sub/root.ts`]: CALLS_CORE_ROOT,
      },
      [`${APP}/badge`, `${APP}/quiet`],
    );
    expect(manifest).toContain(
      `//   - ${APP}/badge: watched boot slot Core.Root`,
    );
    expect(manifest).toContain(`  "${APP}/quiet",`);
    expect(manifest).not.toContain(`  "${APP}/badge",`);
  });

  test("a preloaded descriptor in core pins its plugin", async () => {
    const manifest = await render(
      {
        [`plugins/${APP}/sync/web/index.ts`]: WEB_ENTRY,
        [`plugins/${APP}/sync/core/resource.ts`]:
          'export const d = liveValue("mailSync", { schema: S, preload: "boot" });\n',
      },
      [`${APP}/sync`],
    );
    expect(manifest).toContain("preloaded descriptor (mailSync)");
    expect(manifest).not.toContain(`  "${APP}/sync",`);
  });
});
