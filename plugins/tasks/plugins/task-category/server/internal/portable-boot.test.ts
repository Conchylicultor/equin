/**
 * The proof that task-category's whole server closure is portable: it BOOTS,
 * with no desktop machine half in the graph, on PGlite.
 *
 * The graph is task-category's `dependsOn` closure from the app's server
 * registry (no `machine/` entry at all), plus the providers of a host without
 * the computer — the PGlite database driver (in memory), the in-process job
 * queue, attachment bytes and logs in memory, the seeded push ledger — and one
 * migration source: the committed `data/*.sql` read off disk here, the
 * worker host's bundled text being the next session's job. Only the graph under
 * test must be portable, not this harness.
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
 * Run: `./singularity test plugins/tasks/plugins/task-category`.
 */

import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadResourceByKey,
  type ServerPluginDefinition,
} from "@plugins/framework/plugins/server-core/core";
import {
  bootPluginGraph,
  serverEntries,
  serverEntryFor,
} from "@plugins/framework/plugins/server-core/core/testing";
import { PLUGINS_DIR, REPO_ROOT } from "@plugins/infra/plugins/paths/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import {
  isMigrationFileName,
  migrationsFrom,
  MigrationSource,
} from "@plugins/database/plugins/migrations/server";
import { createTask } from "@plugins/tasks/plugins/tasks-core/server";
import { setTaskCategory } from "./mutations";

setDefaultTimeout(300_000);

type Entry = (typeof serverEntries)[number];

const SUBJECT = "tasks/plugins/task-category";

// The portable providers, as registry entries: none is in the app's registry
// (`base-exclusions` keeps them out of every desktop composition).
const PROVIDERS: Entry[] = [
  serverEntryFor("database/plugins/pglite", ["database"]),
  serverEntryFor("infra/plugins/jobs/plugins/in-process", [
    "infra/plugins/jobs",
    "database",
  ]),
  serverEntryFor("infra/plugins/attachments/plugins/memory-blobs", [
    "infra/plugins/attachments",
  ]),
  serverEntryFor("primitives/plugins/log-channels/plugins/memory-persistence", [
    "primitives/plugins/log-channels",
  ]),
  serverEntryFor("tasks/plugins/tasks-core/plugins/seeded-push-ledger", [
    "tasks/plugins/tasks-core",
  ]),
];

// The committed migration history, read off disk by THIS harness.
const MIGRATIONS_DATA = join(PLUGINS_DIR, "database/plugins/migrations/data");
const migrationSource: Entry = {
  pluginPath: "tasks/plugins/task-category/portable-boot-migrations",
  id: "tasks.task-category.portable-boot-migrations",
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
      ],
    } satisfies ServerPluginDefinition,
  }),
  dependsOn: ["database/plugins/migrations"],
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
      entries: [...closureOf(SUBJECT), ...PROVIDERS, migrationSource],
      hasCoreBarrel: (pluginPath) =>
        existsSync(join(PLUGINS_DIR, pluginPath, "core", "index.ts")),
    });
  });

  test("seeded categories come back through the real task-categories collection", async () => {
    const a = await createTask({ title: "portable boot: categorized" });
    const b = await createTask({ title: "portable boot: also categorized" });
    await createTask({ title: "portable boot: uncategorized" });
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
