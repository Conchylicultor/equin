import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";
/**
 * The proof that task-category's whole server closure is portable: it BOOTS,
 * with no desktop machine half in the graph, on PGlite.
 *
 * The graph is task-category's `dependsOn` closure from the app's server
 * registry (no `machine/` entry at all), plus what a host without the
 * computer boots beside it (`test-host`'s `withPortableHost`: the providers
 * chosen, never listed, the committed migrations and config read off disk,
 * memory host storage). Only the graph under test must be portable, not this
 * harness.
 *
 * Booted through the one boot sequence (`bootPluginGraph`, `exec` mode: load
 * waves, register, collect, the host-service assert, the `onReadyBlocking`
 * barrier — so the real migrations and the real schema layer run on PGlite,
 * which also proves the history applies on PGlite's Postgres). Then tasks and
 * their `tasks_ext_category` rows are written through the real mutations and
 * read back from `task-categories.by-id` through the real `serveCollection` path.
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
import { loadResourceByKey } from "@plugins/framework/plugins/server-core/core";
import { bootPluginGraph } from "@plugins/framework/plugins/server-core/core/testing";
import {
  registryClosureOf,
  withPortableHost,
} from "@plugins/framework/plugins/browser-server/plugins/test-host/server/testing";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { createTask } from "@plugins/tasks/plugins/tasks-core/server";
import { setTaskCategory } from "./mutations";

const TEST_FILING = {
  author: { kind: "human" },
  filedFrom: asPluginId("tasks.task-category"),
} as const;

// Any registered mandate id: these tests never resolve it.
const TEST_MANDATE = defineMandate({ id: "interactive", label: "Interactive" });

setDefaultTimeout(300_000);

const SUBJECT = "tasks/plugins/task-category";

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
      entries: await withPortableHost(registryClosureOf([SUBJECT])),
    });
  });

  test("seeded categories come back through the real task-categories.by-id collection", async () => {
    const a = await createTask({
      filing: TEST_FILING,
      title: "portable boot: categorized",
      mandate: TEST_MANDATE,
    });
    const b = await createTask({
      filing: TEST_FILING,
      title: "portable boot: also categorized",
      mandate: TEST_MANDATE,
    });
    const c = await createTask({
      filing: TEST_FILING,
      title: "portable boot: uncategorized",
      mandate: TEST_MANDATE,
    });
    await setTaskCategory(a.id, "improvements");
    await setTaskCategory(b.id, "deploy");

    const value = await loadResourceByKey("task-categories.by-id:rows", {
      ids: [a.id, b.id, c.id].join(","),
    });
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
