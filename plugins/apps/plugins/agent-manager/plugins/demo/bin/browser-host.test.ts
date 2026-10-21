/**
 * The demo's browser host, booted in Bun: its generated plugin graph
 * (`./browser-host.generated.ts`) on PGlite with the real migrations, seeded by
 * the real `./seed`, then read back through the real served resources — the
 * story the page renders, with no pack behind it — and every read the demo
 * renders (`DEMO_READS`) is either served by that graph or declares
 * `needsMachine`.
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
  jsonlEvents,
  JSONL_EVENTS_MAX,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/core";
import {
  loadResourceByKey,
  Resource,
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
import {
  configConflict,
  configConflictLocations,
  configModifiedCounts,
  configRawFile,
  configScopes,
  configTiers,
  configValues,
} from "@plugins/config_v2/core";
import { sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import {
  DEMO_AGENTS,
  DEMO_STORIES,
  demoAgentId,
  demoConversationId,
  demoTaskId,
} from "../core";
import { DEMO_READS } from "../core/internal/demo-reads";
import { conversationTurns } from "@plugins/conversations/plugins/turn-ledger/core";
import { DEMO_CONVERSATION_ID } from "../core/internal/scenario";
import { hostEntries, hostProviders } from "./browser-host.generated";
import { seed } from "./seed";

setDefaultTimeout(300_000);

type Entry = (typeof hostEntries)[number];

const BUNDLED_SOURCE = hostProviders[MigrationSource.id];
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
    // One page as large as the ceiling: the whole (short) transcript, newest first.
    const rows = (await loadResourceByKey(
      jsonlEvents.key,
      jsonlEvents.query.encode(
        { id: DEMO_CONVERSATION_ID },
        { limit: JSONL_EVENTS_MAX, after: null, until: null },
      ),
    )) as { event: { kind: string; name?: string } }[];
    const events = rows.map((r) => r.event).reverse();
    expect(events[0]?.kind).toBe("user-text");
    expect(
      events.filter((e) => e.kind === "tool-call").map((e) => e.name),
    ).toEqual(["Grep", "Read", "Edit", "Write", "Write", "Bash"]);
    expect(events.at(-1)?.kind).toBe("assistant-text");
  });

  test("every read the demo renders is served by the host or declares needsMachine", () => {
    const served = new Set(
      Resource.Declare.getContributions().map((c) => c.key),
    );
    const uncovered = DEMO_READS.filter(
      (read) =>
        read.needsMachine === undefined &&
        !served.has(read.key) &&
        !served.has(`${read.key}:rows`),
    ).map(
      (read) =>
        `${read.key} is neither served by the demo host nor needsMachine`,
    );
    expect(uncovered).toEqual([]);
  });

  test("the host serves config's portable values, and not the machine-bound raw file", () => {
    // config_v2's server is portable (its documents in browser-store's memory
    // store); the raw-file view of a document's files is config_v2#machine's.
    const served = Resource.Declare.getContributions()
      .map((c) => c.key)
      .filter((key) => key.startsWith("config-v2."));
    expect(served.sort()).toEqual(
      [
        configValues,
        configScopes,
        configConflict,
        configTiers,
        configConflictLocations,
        configModifiedCounts,
      ]
        .map((d) => d.key)
        .sort(),
    );
    expect(served).not.toContain(configRawFile.key);
  });

  test("the stories carry their short titles, tracks, progress and notes", async () => {
    const ids = DEMO_STORIES.map(demoTaskId).join(",");
    const titles = (await loadResourceByKey("task-short-titles:rows", {
      ids,
    })) as { taskId: string; shortTitle: string; sourceTitle: string }[];
    expect(
      new Map(titles.map((r) => [r.taskId, [r.shortTitle, r.sourceTitle]])),
    ).toEqual(
      new Map(DEMO_STORIES.map((s) => [demoTaskId(s), [s.shortTitle, s.task]])),
    );

    const tracks = (await loadResourceByKey("task-tracks.all", {})) as {
      taskId: string;
      track: string;
    }[];
    expect(
      tracks.filter((r) => r.track === "sidequest").map((r) => r.taskId),
    ).toEqual(
      DEMO_STORIES.filter((s) => s.track === "sidequest").map(demoTaskId),
    );

    const conversations = DEMO_STORIES.map(demoConversationId).join(",");
    const progress = (await loadResourceByKey("conversation-progress:rows", {
      ids: conversations,
    })) as { conversationId: string; phase: string }[];
    expect(new Map(progress.map((r) => [r.conversationId, r.phase]))).toEqual(
      new Map(DEMO_STORIES.map((s) => [demoConversationId(s), s.phase])),
    );

    const notes = (await loadResourceByKey("conversation-notes:rows", {
      ids: conversations,
    })) as { conversationId: string; notes: string }[];
    expect(notes.map((r) => [r.conversationId, r.notes])).toEqual(
      DEMO_STORIES.flatMap((s) =>
        s.note === undefined ? [] : [[demoConversationId(s), s.note]],
      ),
    );
  });

  test("the agents roster and the stories' launches", async () => {
    const roster = (await loadResourceByKey("agents.roster", {})) as Row[];
    expect(roster.map((r) => [r.id, r.name])).toEqual(
      DEMO_AGENTS.map((a) => [demoAgentId(a), a.name]),
    );
    const launches = (await loadResourceByKey("agent-launches", {})) as (Row & {
      agentId: string;
      taskId: string;
      latestConversationStatus: string | null;
    })[];
    const launched = DEMO_STORIES.filter((s) => s.agent !== undefined);
    expect(
      launches.map((r) => [r.taskId, r.latestConversationStatus]).sort(),
    ).toEqual(launched.map((s) => [demoTaskId(s), s.status]).sort());
  });

  test("the unseeded keys answer empty, and the catalog is the baseline", async () => {
    expect(
      await loadResourceByKey(
        conversationTurns.key,
        conversationTurns.window.defaultParams,
      ),
    ).toEqual([]);
    expect(
      await loadResourceByKey("data-view-custom-values", {
        dataViewId: "tasks",
      }),
    ).toEqual([]);
    expect(
      await loadResourceByKey("conversation-categories:rows", {
        ids: DEMO_CONVERSATION_ID,
      }),
    ).toEqual([]);
    const catalog = (await loadResourceByKey("model-provider.catalog", {})) as {
      versions: unknown[];
      probedAt: string | null;
    };
    expect(catalog.versions.length).toBeGreaterThan(0);
    expect(catalog.probedAt).toBeNull();
  });
});
