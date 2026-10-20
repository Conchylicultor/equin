/**
 * The demo's browser host, booted in Bun: its generated plugin graph
 * (`./browser-host.generated.ts`) on PGlite with the real migrations, seeded by
 * the real `./seed`, then read back through the real served resources — the
 * story the page renders, with no pack behind it.
 *
 * One substitution: the host's migration history is bundled text
 * (`migrations/bundled-source`, a vite `import.meta.glob`), which Bun cannot
 * evaluate, so this harness provides the same history read off disk. Every
 * other entry is the graph the worker boots.
 *
 * Boots in a FRESH bun process (this file re-run as a child with
 * `DEMO_HOST_BOOT_CHILD` set): a boot collects its own host-service providers
 * and registers its graph's resources process-wide, which would leak into every
 * suite after it in the shared `bun test` process.
 *
 * Run: `./singularity test plugins/apps/plugins/agent-manager/plugins/demo`.
 */

import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadResourceByKey,
  type ServerPluginDefinition,
} from "@plugins/framework/plugins/server-core/core";
import { bootPluginGraph } from "@plugins/framework/plugins/server-core/core/testing";
import { PLUGINS_DIR, REPO_ROOT } from "@plugins/infra/plugins/paths/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import {
  isMigrationFileName,
  migrationsFrom,
  MigrationSource,
} from "@plugins/database/plugins/migrations/server";
import { sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { DEMO_STORIES, demoTaskId } from "../core";
import { DEMO_CONVERSATION_ID } from "../core/internal/scenario";
import { hostEntries } from "./browser-host.generated";
import { seed } from "./seed";

setDefaultTimeout(300_000);

type Entry = (typeof hostEntries)[number];

const BUNDLED_SOURCE = "database/plugins/migrations/plugins/bundled-source";
const MIGRATIONS_DATA = join(PLUGINS_DIR, "database/plugins/migrations/data");
const diskMigrations: Entry = {
  pluginPath: "apps/plugins/agent-manager/plugins/demo/boot-test-migrations",
  id: "apps.agent-manager.demo.boot-test-migrations",
  loader: async () => ({
    default: {
      portable: true,
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

const IN_CHILD = process.env.DEMO_HOST_BOOT_CHILD === "1";

if (!IN_CHILD) {
  test("the demo's browser host boots and serves its story (in a fresh process)", async () => {
    const result = await spawnCaptured(
      [process.execPath, "test", import.meta.path],
      {
        cwd: REPO_ROOT,
        // Its own graph: no desktop providers from the test preload.
        env: {
          ...process.env,
          DEMO_HOST_BOOT_CHILD: "1",
          BOOTS_OWN_PLUGIN_GRAPH: "1",
        },
        timeoutMs: 240_000,
      },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `demo host boot child exited ${result.exitCode}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
      );
    }
    expect(result.exitCode).toBe(0);
  });
}

type Row = Record<string, unknown> & { id: string };

describe.if(IN_CHILD)("the demo's browser host", () => {
  beforeAll(async () => {
    const graph = hostEntries.filter((e) => e.pluginPath !== BUNDLED_SOURCE);
    expect(graph).toHaveLength(hostEntries.length - 1);
    const ordered = await bootPluginGraph({
      // The worker's own mode (`bootBrowserHost`): no L2, frames without a
      // commit watermark.
      mode: "browser",
      entries: [...graph, diskMigrations],
      hasCoreBarrel: () => false,
    });
    // What the worker asserts at boot (`bootBrowserHost`).
    expect(ordered.filter((p) => p.portable !== true).map((p) => p.id)).toEqual(
      [],
    );
    await seed();
  });

  test("tasks carry the stories' categories", async () => {
    const rows = (await loadResourceByKey("tasks", {})) as Row[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const story of DEMO_STORIES) {
      const row = byId.get(demoTaskId(story));
      expect(row).toBeDefined();
      // The exposed field, folded under its exposure (the side table).
      const columns = row!.$columns as {
        tasks_ext_category?: { category: string | null };
      };
      expect(columns.tasks_ext_category?.category ?? null).toBe(
        story.category ?? null,
      );
    }
  });

  test("the queue holds the live conversations, the done list the finished ones", async () => {
    const active = (await loadResourceByKey(
      "conversations-active",
      {},
    )) as Row[];
    const live = DEMO_STORIES.filter((s) => s.status !== "done");
    expect(active.map((r) => r.id).sort()).toEqual(
      live.map((s) => `conv-demo-${s.key}`).sort(),
    );
    const ranked = await db.execute<{ id: string }>(
      sql`SELECT parent_id AS id FROM conversations_ext_queue`,
    );
    expect(ranked.rows.map((r) => r.id).sort()).toEqual(
      live.map((s) => `conv-demo-${s.key}`).sort(),
    );
  });

  test("the open conversation's transcript parses from its JSONL", async () => {
    const events = (await loadResourceByKey("jsonl-events", {
      id: DEMO_CONVERSATION_ID,
    })) as { kind: string; name?: string }[];
    expect(events[0]?.kind).toBe("user-text");
    expect(
      events.filter((e) => e.kind === "tool-call").map((e) => e.name),
    ).toEqual(["Grep", "Read", "Edit", "Write", "Write", "Bash"]);
    expect(events.at(-1)?.kind).toBe("assistant-text");
  });
});
