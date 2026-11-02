/**
 * The proof that task-category's whole server closure is portable: it BOOTS,
 * with no desktop machine half in the graph, on PGlite.
 *
 * The graph is task-category's `dependsOn` closure from the app's server
 * registry (no `machine/` entry at all), plus the providers of a host without
 * the computer — chosen, not listed: every service the graph's modules declare
 * gets the one host provider that provides it (the PGlite
 * driver, the in-process job queue, the in-memory config store, …), to a
 * fixpoint, the way codegen picks a browser host's (`browser-host-gen.ts`). A
 * hand-kept list went stale each time the closure reached a new service. Two
 * services are the harness's own: the committed migrations and `config/`, read
 * off disk here (their bundled providers inline them with `import.meta.glob`,
 * which Bun has not). Only the graph under test must be portable, not this
 * harness.
 *
 * Booted through the one boot sequence (`bootPluginGraph`, `exec` mode: load
 * waves, register, collect, the host-service assert, the `onReadyBlocking`
 * barrier — so the real migrations and the real schema layer run on PGlite,
 * which also proves the history applies on PGlite's Postgres). Then tasks and
 * their `tasks_ext_category` rows are written through the real mutations and
 * read back from `task-categories` through the real `serveCollection` path.
 *
 * It boots in a FRESH bun process (this same file, re-run as a child with
 * `PORTABLE_BOOT_CHILD` set): a boot collects its own host-service providers
 * and registers its graph's jobs and resources process-wide, so in the shared
 * `bun test` process it would both see what other suites registered and leave
 * PGlite answering for every suite after it.
 *
 * Run: `./equin test plugins/tasks/plugins/task-category`.
 */

import { defineMandate } from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/policy/core";
import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadResourceByKey,
  type ServerPluginDefinition,
} from "@plugins/framework/plugins/server-core/core";
import {
  bootPluginGraph,
  declaredHostServiceIds,
  hostServicesProvidedBy,
  isHostService,
  serverEntries,
  serverEntryFor,
} from "@plugins/framework/plugins/server-core/core/testing";
import { providedServiceNames } from "@plugins/plugin-meta/plugins/parse-utils/core";
import { PLUGINS_DIR, REPO_ROOT } from "@plugins/infra/plugins/paths/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import {
  isMigrationFileName,
  migrationsFrom,
  MigrationSource,
} from "@plugins/database/plugins/migrations/server";
import { createTask } from "@plugins/tasks/plugins/tasks-core/server";
import { ConfigGitLayer } from "@plugins/config_v2/server";
import {
  committedDocument,
  committedFilesFromMap,
  type CommittedFiles,
} from "@plugins/config_v2/core";
import { Glob } from "bun";
import { setTaskCategory } from "./mutations";

// Any registered mandate id: these tests never resolve it.
const TEST_MANDATE = defineMandate({ id: "interactive", label: "Interactive" });

setDefaultTimeout(300_000);

type Entry = (typeof serverEntries)[number];

const SUBJECT = "tasks/plugins/task-category";

/**
 * The portable providers' candidates: every host provider — a plugin whose
 * `server/index.ts` calls `<Service>.provide(…)`, which no composition bundles
 * (the closure engine's `EdgeGraph.hostProviders`, so none is in the app's
 * registry) — with its source. Read, never loaded: loading one evaluates its
 * service owner's modules, whose declarations the boot would then demand.
 */
function providerCandidates(): { path: string; source: string }[] {
  const out: { path: string; source: string }[] = [];
  // Plugin folders only (`<p>/plugins/<child>/…`), never a package's own tree.
  const visit = (path: string): void => {
    const barrel = join(PLUGINS_DIR, path, "server", "index.ts");
    if (existsSync(barrel)) {
      const source = readFileSync(barrel, "utf8");
      if (providedServiceNames(source).length > 0) out.push({ path, source });
    }
    const children = join(PLUGINS_DIR, path, "plugins");
    if (!existsSync(children)) return;
    for (const child of readdirSync(children, { withFileTypes: true })) {
      if (child.isDirectory()) visit(`${path}/plugins/${child.name}`);
    }
  };
  for (const top of readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (top.isDirectory()) visit(top.name);
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

type LoadedBarrel = Record<string, unknown> & {
  default: ServerPluginDefinition;
};

/**
 * `graph` plus one provider per host service its modules declare, to a
 * fixpoint (a provider's own modules may declare another), the way codegen
 * picks a browser host's: the candidate whose barrel spells
 * `<Service>.provide(` — the service named by the binding a loaded barrel
 * exports it under. Modules load one at a time here, so no barrel races
 * another. A service with no candidate, or two, fails, naming them.
 */
async function withProviders(graph: Entry[]): Promise<Entry[]> {
  const entries = [...graph];
  const candidates = providerCandidates();
  const provided = new Set<string>();
  const bindingOf = new Map<string, string>();
  const load = async (entry: Entry): Promise<void> => {
    const mod = (await entry.loader()) as LoadedBarrel;
    for (const id of hostServicesProvidedBy(mod.default.contributions ?? [])) {
      provided.add(id);
    }
    for (const [name, value] of Object.entries(mod)) {
      if (isHostService(value)) bindingOf.set(value.id, name);
    }
  };
  for (const e of entries) await load(e);
  for (;;) {
    const missing = declaredHostServiceIds().filter((id) => !provided.has(id));
    if (missing.length === 0) return entries;
    const members = entries.map((e) => e.pluginPath);
    for (const id of missing) {
      if (provided.has(id)) continue; // a provider chosen above serves it too
      const binding = bindingOf.get(id);
      if (binding === undefined) {
        throw new Error(
          `host service "${id}" is declared but no loaded server barrel exports it, so its provider cannot be named`,
        );
      }
      const spelled = new RegExp(`\\b${binding}\\.provide\\(`);
      const by = candidates.filter((c) => spelled.test(c.source));
      if (by.length !== 1) {
        throw new Error(
          `host service "${id}" (${binding}) has ${by.length} host providers: ${by.map((c) => c.path).join(", ") || "none"}`,
        );
      }
      // Loaded after everything chosen so far: its import of the service's
      // owner never races that owner's load wave.
      const provider = serverEntryFor(by[0]!.path, members);
      entries.push(provider);
      await load(provider);
    }
  }
}

// What the bundled providers inline with `import.meta.glob` (which Bun has
// not), read off disk by THIS harness instead: the committed migration history
// and the committed config layer. Their services count as provided, so
// `withProviders` never picks the bundled candidates.
const MIGRATIONS_DATA = join(PLUGINS_DIR, "database/plugins/migrations/data");
const CONFIG_DIR = join(REPO_ROOT, "config");
let committedConfig: CommittedFiles | undefined;
const committedFromDisk: Entry = {
  pluginPath: "tasks/plugins/task-category/portable-boot-committed",
  id: "tasks.task-category.portable-boot-committed",
  loader: async () => ({
    default: {
      contributions: [
        MigrationSource.provide({
          list: () =>
            migrationsFrom(
              readdirSync(MIGRATIONS_DATA)
                .filter(isMigrationFileName)
                .map((file) => ({
                  file,
                  sqlText: readFileSync(join(MIGRATIONS_DATA, file), "utf8"),
                })),
            ),
        }),
        ConfigGitLayer.provide({
          document(storePath) {
            committedConfig ??= committedFilesFromMap(
              new Map(
                [...new Glob("**/*.jsonc").scanSync(CONFIG_DIR)].map((rel) => [
                  rel,
                  readFileSync(join(CONFIG_DIR, rel), "utf8"),
                ]),
              ),
            );
            return committedDocument(storePath, committedConfig);
          },
          // Read once: the checkout does not change under one test run.
          watch: () => Promise.resolve(() => {}),
        }),
      ],
    } satisfies ServerPluginDefinition,
  }),
  dependsOn: ["database/plugins/migrations", "config_v2"],
};

/** `SUBJECT`'s `dependsOn` closure in the app's server registry. */
function closureOf(root: string): Entry[] {
  const byPath = new Map(serverEntries.map((e) => [e.pluginPath, e]));
  const seen = new Set<string>();
  const stack = [root];
  while (stack.length > 0) {
    const path = stack.pop()!;
    if (seen.has(path)) continue;
    const entry = byPath.get(path);
    if (entry === undefined) {
      throw new Error(`${path} is not in the server registry`);
    }
    seen.add(path);
    stack.push(...entry.dependsOn);
  }
  return serverEntries.filter((e) => seen.has(e.pluginPath));
}

const IN_CHILD = process.env.PORTABLE_BOOT_CHILD === "1";

if (!IN_CHILD) {
  test("task-category's server closure boots portably (in a fresh process)", async () => {
    const result = await spawnCaptured(
      [process.execPath, "test", import.meta.path],
      {
        // The repo root, so the child reads the same bunfig (test preload).
        cwd: REPO_ROOT,
        // Its own graph: no desktop providers from the test preload.
        env: {
          ...process.env,
          PORTABLE_BOOT_CHILD: "1",
          BOOTS_OWN_PLUGIN_GRAPH: "1",
        },
        timeoutMs: 240_000,
      },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `portable boot child exited ${result.exitCode}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
      );
    }
    expect(result.exitCode).toBe(0);
  });
}

describe.if(IN_CHILD)("task-category's server closure boots portably", () => {
  beforeAll(async () => {
    await bootPluginGraph({
      mode: "exec",
      entries: await withProviders([...closureOf(SUBJECT), committedFromDisk]),
      coreBarrel: (pluginPath) =>
        existsSync(join(PLUGINS_DIR, pluginPath, "core", "index.ts"))
          ? () => import(`@plugins/${pluginPath}/core`)
          : null,
    });
  });

  test("seeded categories come back through the real task-categories collection", async () => {
    const a = await createTask({
      title: "portable boot: categorized",
      mandate: TEST_MANDATE,
    });
    const b = await createTask({
      title: "portable boot: also categorized",
      mandate: TEST_MANDATE,
    });
    await createTask({
      title: "portable boot: uncategorized",
      mandate: TEST_MANDATE,
    });
    await setTaskCategory(a.id, "improvements");
    await setTaskCategory(b.id, "deploy");

    const value = await loadResourceByKey("task-categories", {});
    const rows = (value as { taskId: string; category: string }[])
      .map((r) => ({ taskId: r.taskId, category: r.category }))
      .sort((x, y) => x.taskId.localeCompare(y.taskId));
    expect(rows).toEqual(
      [
        { taskId: a.id, category: "improvements" },
        { taskId: b.id, category: "deploy" },
      ].sort((x, y) => x.taskId.localeCompare(y.taskId)),
    );
  });
});
