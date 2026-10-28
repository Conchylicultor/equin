/**
 * The demo's browser host, booted in Bun: its generated plugin graph
 * (`./browser-host.generated.ts`) on PGlite with the real migrations, seeded by
 * the real `./seed`, then read back through the real served resources — the
 * story the page renders, with no pack behind it — and every read the scoped
 * page references (`hostReads`, the build's coverage guard's answer, generated
 * beside the scope) is either served by the booted graph or declares
 * `needsMachine`: the static and the runtime view of the host cannot drift.
 *
 * And a write through the real mutations recomputes its readers through the
 * worker's own change feed (PGlite triggers → NOTIFY → the listener `onReady`
 * started → the router): a subscriber of the tasks collection and of one
 * task's row gets the change, acked by the write's transaction id — and a
 * fresh read after it carries a commit watermark above that id, so an op whose
 * exact ack is missed still confirms. L2 (`live-state-snapshot`) runs in the
 * worker too: the changelog every write appends to is pruned by the desktop's
 * own policy.
 *
 * Two substitutions, one per provider whose data is bundled text (a vite
 * `import.meta.glob`, which Bun cannot evaluate): the migration history
 * (`migrations/bundled-source`) and the committed config layer
 * (`config_v2/bundled-layer`) are provided by the same data read off disk.
 * Every other entry is the graph the worker boots. The seed's own bundled
 * input — the demo's prototypes and their thumbnails — is read off disk the
 * same way (`diskDemoPrototypes` below).
 *
 * Boots in a FRESH bun process (this file re-run as a child with
 * `DEMO_HOST_BOOT_CHILD` set): a boot collects its own host-service providers
 * and registers its graph's resources process-wide, which would leak into every
 * suite after it in the shared `bun test` process.
 *
 * The seed runs on the LIVE host (after the post-ready phases), so what the
 * pages derive — backlinks, search docs, history snapshots — is asserted here
 * as the triggers and jobs left it, with no derivation call in the seed.
 *
 * Run: `./equin test plugins/apps/plugins/website/plugins/demos/plugins/lumen`.
 */

import { mandatePolicy } from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/policy/core";
import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";
import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import {
  jsonlEvents,
  JSONL_EVENTS_MAX,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/core";
import {
  bootBrowserHost,
  loadResourceByKey,
  Resource,
  type BrowserHost,
  type ResourceParams,
  type ServerPluginDefinition,
} from "@plugins/framework/plugins/server-core/core";
import { unmatchedApiResponse } from "@plugins/infra/plugins/endpoints/core";
import { PLUGINS_DIR, REPO_ROOT } from "@plugins/infra/plugins/paths/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import {
  isMigrationFileName,
  migrationsFrom,
  MigrationSource,
} from "@plugins/database/plugins/migrations/server";
import {
  appScopeId,
  committedDocument,
  committedFilesFromMap,
  configConflict,
  configConflictLocations,
  configGitValues,
  configModifiedCounts,
  configRawFile,
  configScopes,
  configTiers,
  configValues,
  type ConfigV2ScopesMap,
} from "@plugins/config_v2/core";
import {
  ConfigGitLayer,
  ConfigStore,
  getAllDescriptors,
  setConfigByPath,
} from "@plugins/config_v2/server";
import { systemOrigin } from "@plugins/infra/plugins/request-origin/core";
import { sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { pruneChangelog } from "@plugins/database/plugins/live-state-snapshot/server/testing";
import {
  createTask,
  updateTask,
} from "@plugins/tasks/plugins/tasks-core/server";
import {
  taskDescriptions,
  taskRows,
} from "@plugins/tasks/plugins/tasks-core/core";
import {
  DARK_MODE_PAGE_WORK,
  DEMO_AGENTS,
  DEMO_PAGE_IDS,
  DEMO_STORIES,
  demoAgentId,
  demoConversationId,
  demoPromptOf,
  demoStoryByKey,
  demoTaskId,
} from "../core";
import type { ToolCallEvent } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import { parsePageApplyReport } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/plugins/page-tools/core";
import { readBlockAsMarkdown } from "@plugins/page/plugins/markdown-apply/server";
import { pageTools } from "@plugins/page/plugins/annotations/plugins/agent-access/server";
import { loadPageTags } from "@plugins/page/plugins/tags/server";
import { promptBlock } from "@plugins/page/plugins/prompt/plugins/link/server";
import { PAGES_CATEGORY_ID } from "@plugins/page/plugins/prompt/plugins/link/core";
import { searchResults } from "@plugins/search/plugins/engine/core";
import { hostReads } from "../core/browser-host.generated";
import { conversationTurns } from "@plugins/conversations/plugins/turn-ledger/core";
import { DEMO_CONVERSATION_ID } from "../core/internal/scenario";
import { hostEntries, hostProviders } from "./browser-host.generated";
import { seed } from "./seed";
import {
  DEMO_PINNED_PROTOTYPE,
  DEMO_PROTOTYPE_TAGS,
} from "../core/internal/prototypes";
import {
  parsePrototypeTree,
  prototypeFixtureDataOf,
  prototypeFixtureVersionFingerprint,
  type PrototypeFixtureData,
} from "@plugins/apps/plugins/prototypes/plugins/fixtures/core";
import {
  createPrototype,
  type PrototypeHistory,
  type PrototypeMeta,
} from "@plugins/apps/plugins/prototypes/plugins/files/core";
import type { ThumbnailState } from "@plugins/apps/plugins/prototypes/plugins/thumbnails/core";

setDefaultTimeout(300_000);

/** The demo's `data/` folder off disk, as the seed reads it (the worker has it inlined). */
function diskDemoPrototypes(): PrototypeFixtureData {
  const dir = join(import.meta.dir, "..", "data");
  const files: Record<string, Uint8Array> = {};
  for (const rel of readdirSync(dir, { recursive: true }) as string[])
    if (statSync(join(dir, rel)).isFile())
      files[rel.split(sep).join("/")] = new Uint8Array(
        readFileSync(join(dir, rel)),
      );
  return prototypeFixtureDataOf(files);
}

type Entry = (typeof hostEntries)[number];

const MIGRATIONS_DATA = join(PLUGINS_DIR, "database/plugins/migrations/data");
const diskMigrations: Entry = {
  pluginPath:
    "apps/plugins/website/plugins/demos/plugins/lumen/boot-test-migrations",
  id: "apps.website.demos.lumen.boot-test-migrations",
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

/** The repo's `config/`, read off disk: what the bundled layer inlines. */
function diskConfigFiles(): Map<string, string> {
  const dir = join(REPO_ROOT, "config");
  const files = new Map<string, string>();
  for (const rel of readdirSync(dir, { recursive: true }) as string[]) {
    if (!rel.endsWith(".jsonc") || !statSync(join(dir, rel)).isFile()) continue;
    files.set(rel, readFileSync(join(dir, rel), "utf8"));
  }
  return files;
}
const committedFiles = committedFilesFromMap(diskConfigFiles());
const diskGitLayer: Entry = {
  pluginPath:
    "apps/plugins/website/plugins/demos/plugins/lumen/boot-test-config",
  id: "apps.website.demos.lumen.boot-test-config",
  loader: async () => ({
    default: {
      portable: true,
      contributions: [
        ConfigGitLayer.provide({
          document: (storePath) => committedDocument(storePath, committedFiles),
          watch: () => Promise.resolve(() => {}),
        }),
      ],
    } satisfies ServerPluginDefinition,
  }),
  dependsOn: ["config_v2"],
};

/**
 * Host service → the disk-backed entry standing in for its bundled provider.
 * Each swapped provider must provide that one service only, or the swap would
 * drop another service with it.
 */
const SWAPS: Record<string, Entry> = {
  [MigrationSource.id]: diskMigrations,
  [ConfigGitLayer.id]: diskGitLayer,
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

/** A server frame, as far as these assertions read it. */
interface Frame {
  kind: string;
  key?: string;
  params?: ResourceParams;
  ackTx?: string[];
  watermark?: string;
}

function isFor(frame: Frame, key: string, params: ResourceParams): boolean {
  return (
    frame.key === key &&
    JSON.stringify(frame.params ?? {}) === JSON.stringify(params)
  );
}

/** Wait (bounded) until `probe` answers something truthy; fail loudly naming `what`. */
async function until<T>(
  probe: () => T | undefined | false | Promise<T | undefined | false>,
  what: string,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const got = await probe();
    if (got !== undefined && got !== false) return got;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe.if(IN_CHILD)("the demo's browser host", () => {
  let host: BrowserHost;
  beforeAll(async () => {
    const swapped = new Set(
      Object.keys(SWAPS).map((service) => hostProviders[service]),
    );
    expect(swapped.size).toBe(Object.keys(SWAPS).length);
    for (const [service, provider] of Object.entries(hostProviders)) {
      if (swapped.has(provider)) expect(Object.keys(SWAPS)).toContain(service);
    }
    const graph = hostEntries.filter((e) => !swapped.has(e.pluginPath));
    expect(graph).toHaveLength(hostEntries.length - swapped.size);
    // The worker's own boot (`./browser-host.ts`): browser mode, every plugin
    // asserted portable, the resource key set closed.
    host = await bootBrowserHost({
      entries: [...graph, ...Object.values(SWAPS)],
      seed: () => seed(diskDemoPrototypes()),
      onUnmatched: unmatchedApiResponse,
    });
  });

  test("a key the host does not serve is refused as unserved, not as skew", async () => {
    const res = await host.request(
      new Request("http://demo.invalid/api/resources/nope", {
        headers: {
          [`${LEGACY_IDS.headerPrefix}build-graph`]: "some-other-build",
        },
      }),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ reason: "unserved" });
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

  /** The open conversation's events, oldest first, as the real parser reads its JSONL. */
  async function openConversationEvents(): Promise<
    ({ kind: string; name?: string; text?: string } | ToolCallEvent)[]
  > {
    // One page as large as the ceiling: the whole (short) transcript, newest first.
    const rows = (await loadResourceByKey(
      jsonlEvents.key,
      jsonlEvents.query.encode(
        { id: DEMO_CONVERSATION_ID },
        { limit: JSONL_EVENTS_MAX, after: null, until: null },
      ),
    )) as { event: { kind: string; name?: string } }[];
    return rows.map((r) => r.event).reverse();
  }
  const toolCalls = async (suffix: string) =>
    (await openConversationEvents()).filter(
      (e): e is ToolCallEvent =>
        e.kind === "tool-call" && (e.name ?? "").endsWith(suffix),
    );

  test("the open conversation's transcript parses from its JSONL", async () => {
    const events = await openConversationEvents();
    expect(events[0]?.kind).toBe("user-text");
    expect(
      events.filter((e) => e.kind === "tool-call").map((e) => e.name),
    ).toEqual([
      "mcp__equin__read_page",
      "mcp__equin__read_page",
      "Grep",
      "Read",
      "mcp__equin__edit_page",
      "Edit",
      "Write",
      "Write",
      "Bash",
      "mcp__equin__write_agent_note",
    ]);
    expect(events.at(-1)?.kind).toBe("assistant-text");
  });

  /** Every live page row: id → [parent, page, title]. */
  async function livePages(): Promise<
    Map<string, [string | null, string | null, string]>
  > {
    const rows = await db.execute<{
      id: string;
      parent_id: string | null;
      page_id: string | null;
      title: string;
    }>(
      sql`SELECT id, parent_id, page_id, data->>'title' AS title FROM page_blocks
          WHERE type = 'page' AND deleted_at IS NULL`,
    );
    return new Map(
      rows.rows.map((r) => [r.id, [r.parent_id, r.page_id, r.title]]),
    );
  }

  test("the Lumen workspace: its pages, their hierarchy, and the page the agent minted", async () => {
    const pages = await livePages();
    const { lumen, spec, bugs, ideas } = DEMO_PAGE_IDS;
    expect(pages.get(lumen)).toEqual([null, null, "Lumen"]);
    expect(pages.get(ideas)).toEqual([null, null, "Ideas"]);
    expect(pages.get(spec)).toEqual([lumen, lumen, "Theme & storage spec"]);
    expect(pages.get(bugs)).toEqual([lumen, lumen, "Bugs"]);
    const seeded = new Set<string>([lumen, spec, bugs, ideas]);
    const minted = [...pages].filter(([id]) => !seeded.has(id));
    expect(minted.map(([, v]) => v)).toEqual([
      [bugs, bugs, DARK_MODE_PAGE_WORK.investigationTitle],
    ]);
  });

  test("the seed derives nothing by hand: it writes, the host derives", async () => {
    const source = readFileSync(join(import.meta.dir, "seed.ts"), "utf8");
    for (const derivation of [
      "reindexPage",
      "reindexPageSearch",
      "recordAgentNotesAuthor",
      "applySummary",
    ])
      expect(source).not.toContain(derivation);
  });

  test("every page, the agent's included, derived its search doc and a history snapshot", async () => {
    const pages = [...(await livePages()).keys()].sort();
    expect(pages).toHaveLength(5);
    const docs = await db.execute<{ entity_id: string }>(
      sql`SELECT entity_id FROM search_documents WHERE source = 'pages' ORDER BY entity_id`,
    );
    expect(docs.rows.map((d) => d.entity_id)).toEqual(pages);
    const versions = await db.execute<{ entity_id: string }>(
      sql`SELECT DISTINCT entity_id FROM entity_versions
          WHERE source_id = 'pages' ORDER BY entity_id`,
    );
    expect(versions.rows.map((v) => v.entity_id)).toEqual(pages);
  });

  test("the backlinks index holds the inline link from Lumen to the spec", async () => {
    const edges = await db.execute<{ source: string; target: string }>(
      sql`SELECT source_page_id AS source, target_page_id AS target FROM page_links`,
    );
    expect(edges.rows).toContainEqual({
      source: DEMO_PAGE_IDS.lumen,
      target: DEMO_PAGE_IDS.spec,
    });
  });

  test("the pages carry their tags and Lumen its star", async () => {
    expect(
      (await loadPageTags(DEMO_PAGE_IDS.lumen)).map((t) => t.name),
    ).toEqual(["In progress"]);
    expect((await loadPageTags(DEMO_PAGE_IDS.bugs)).map((t) => t.name)).toEqual(
      ["Bug"],
    );
    const starred = await db.execute<{ id: string }>(
      sql`SELECT parent_id AS id FROM page_blocks_ext_starred`,
    );
    expect(starred.rows.map((r) => r.id)).toEqual([DEMO_PAGE_IDS.lumen]);
  });

  test("the dark-mode task was launched from the Bugs page's prompt block", async () => {
    const story = demoStoryByKey("dark-mode");
    expect(story.category).toBe(PAGES_CATEGORY_ID);
    expect(await promptBlock.get(demoTaskId(story))).toMatchObject({
      pageId: DEMO_PAGE_IDS.bugs,
      blockId: DEMO_PAGE_IDS.prompt,
    });
    const prompt = await db.execute<{ text: string }>(
      sql`SELECT data->'text'->0->>'text' AS text FROM page_blocks WHERE id = ${DEMO_PAGE_IDS.prompt}`,
    );
    expect(prompt.rows[0]?.text).toBe(demoPromptOf(story));
  });

  test("the transcript records the agent's real page work, and its writes are stamped", async () => {
    // A read of a page the agent never wrote reads back today, through the
    // same tool, exactly as the transcript recorded it.
    const [readOrigin, readSpec] = await toolCalls("read_page");
    const reread = await pageTools.read(
      { block_id: DEMO_PAGE_IDS.spec },
      { conversationId: DEMO_CONVERSATION_ID },
    );
    expect(readSpec!.result?.content).toBe(reread.content[0].text);
    expect(readOrigin!.result?.content).toContain(
      demoPromptOf(demoStoryByKey("dark-mode")),
    );

    const [edit] = await toolCalls("edit_page");
    const report = parsePageApplyReport(edit!);
    expect(report).not.toBeNull();
    expect(report!.page_id).toBe(DEMO_PAGE_IDS.bugs);
    expect(report!.replaced).toBe(1);
    const pages = await livePages();
    const investigation = [...pages].find(
      ([, v]) => v[2] === DARK_MODE_PAGE_WORK.investigationTitle,
    )![0];
    expect(report!.created_page_ids).toEqual([investigation]);
    expect(report!.note_ids).toHaveLength(2);
    const [card, page] = report!.note_ids as [string, string];
    expect(page).toBe(investigation);

    const [note] = await toolCalls("write_agent_note");
    const noted = parsePageApplyReport(note!);
    expect(noted!.scope_id).toBe(card);
    expect(noted!.note_ids).toEqual([card]);

    const authors = await db.execute<{
      block_id: string;
      conversation_id: string;
    }>(
      sql`SELECT block_id, conversation_id FROM page_blocks_agent_authors ORDER BY block_id`,
    );
    expect(
      authors.rows.map((r) => [r.block_id, r.conversation_id]).sort(),
    ).toEqual(
      [
        [card, DEMO_CONVERSATION_ID],
        [investigation, DEMO_CONVERSATION_ID],
      ].sort(),
    );
    // The card holds the note's final contents, and the agent page is the agent's.
    const cardRead = await readBlockAsMarkdown(card!);
    expect(cardRead).toContain(DARK_MODE_PAGE_WORK.cardDone);
  });

  test("full-text search finds a seeded page on PGlite", async () => {
    const hits = (await loadResourceByKey(
      searchResults.key,
      searchResults.query.encode({ q: "storage spec", sources: ["pages"] }),
    )) as { entityId: string }[];
    expect(hits.map((h) => h.entityId)).toContain(DEMO_PAGE_IDS.spec);
  });

  test("every read the coverage guard derived is served by the booted host or declares needsMachine", () => {
    const served = new Set(
      Resource.Declare.getContributions().map((c) => c.key),
    );
    // A collection's mints share its key (`k`, `k:rows`, `k:groups`…), and a
    // read names the declaration's key.
    const servedBase = new Set(
      [...served].map((k) => k.replace(/:[^:.]+$/, "")),
    );
    expect(hostReads.length).toBeGreaterThan(0);
    const uncovered = hostReads
      .filter((read) => !read.needsMachine && !servedBase.has(read.key))
      .map(
        (read) =>
          `${read.key} is neither served by the booted host nor needsMachine`,
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
        configGitValues,
        configModifiedCounts,
      ]
        .map((d) => d.key)
        .sort(),
    );
    expect(served).not.toContain(configRawFile.key);
  });

  test("every registered document starts as a fresh user's: its origins are the committed layer", async () => {
    const scopes = (await loadResourceByKey(
      configScopes.key,
      {},
    )) as ConfigV2ScopesMap;
    const paths = Object.keys(scopes);
    expect(paths.length).toBeGreaterThan(0);
    const store = ConfigStore.get();
    const mismatched: string[] = [];
    for (const storePath of paths) {
      const doc = committedDocument(storePath, committedFiles);
      if (doc === undefined) {
        mismatched.push(`${storePath}: nothing committed`);
        continue;
      }
      const origin = store.proxy({ storePath, file: "origin" }).read();
      if (JSON.stringify(origin?.content) !== JSON.stringify(doc.base))
        mismatched.push(`${storePath}: base origin differs`);
      for (const [appId, scoped] of Object.entries(doc.scopes)) {
        const scopeId = appScopeId(appId);
        const read = store.proxy({ storePath, scopeId, file: "origin" }).read();
        if (JSON.stringify(read?.content) !== JSON.stringify(scoped))
          mismatched.push(`${storePath} ${scopeId}: scoped origin differs`);
        if (!scopes[storePath]!.includes(scopeId))
          mismatched.push(
            `${storePath}: ${scopeId} missing from the scopes map`,
          );
      }
    }
    expect(mismatched).toEqual([]);
  });

  test("reorder's directives read their committed arrangement, not empty defaults", async () => {
    const directives = getAllDescriptors().filter(
      ([, d]) => d.source === "reorder",
    );
    expect(directives.length).toBeGreaterThan(0);
    const empty: string[] = [];
    for (const [storePath] of directives) {
      const values = (await loadResourceByKey(configValues.key, {
        path: storePath,
      })) as { items?: unknown[] };
      const committed = committedDocument(storePath, committedFiles)?.base as
        { items?: unknown[] } | undefined;
      if (
        (committed?.items?.length ?? 0) > 0 &&
        (values.items?.length ?? 0) === 0
      )
        empty.push(storePath);
    }
    expect(empty).toEqual([]);
  });

  test("a config write round-trips: set-field's registry path, read back live", async () => {
    // Any registered document with a top-level boolean: flip it.
    let target: { storePath: string; key: string; value: boolean } | undefined;
    for (const [storePath] of getAllDescriptors()) {
      const values = (await loadResourceByKey(configValues.key, {
        path: storePath,
      })) as Record<string, unknown>;
      const key = Object.keys(values).find(
        (k) => typeof values[k] === "boolean",
      );
      if (key !== undefined) {
        target = { storePath, key, value: values[key] as boolean };
        break;
      }
    }
    expect(target).toBeDefined();
    const { storePath, key, value } = target!;
    await setConfigByPath(storePath, key, !value, {
      writer: systemOrigin("demo-host-test"),
    });
    const after = (await loadResourceByKey(configValues.key, {
      path: storePath,
    })) as Record<string, unknown>;
    expect(after[key]).toBe(!value);
    // Written against the propagated origin: an override in force, no conflict.
    const store = ConfigStore.get();
    expect(store.proxy({ storePath, file: "override" }).read()?.hash).toBe(
      store.proxy({ storePath, file: "origin" }).read()?.hash,
    );
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
  test("a write recomputes its subscribers through the worker's change feed, acked by its xid", async () => {
    const frames: Frame[] = [];
    const socket = {
      send(raw: string) {
        const frame = JSON.parse(raw) as Frame;
        if (frame.kind !== "ping") frames.push(frame);
      },
    };
    const ws = host.notifications as unknown as {
      open(ws: unknown): void;
      message(ws: unknown, raw: string): void;
      close(ws: unknown, code: number, reason: string): void;
    };
    ws.open(socket);
    let nextId = 1;
    const subscribe = async (key: string, params: ResourceParams) => {
      ws.message(
        socket,
        JSON.stringify({ op: "sub", id: nextId++, key, params }),
      );
      await until(
        () => frames.some((f) => isFor(f, key, params) && f.kind === "sub-ack"),
        `sub-ack ${key}`,
      );
    };
    // The write's own transaction, so its xid is known: the mutations join a
    // transaction they are handed.
    const inTx = async <T>(
      fn: (
        tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
      ) => Promise<T>,
    ) => {
      let xid = "";
      const value = await db.transaction(async (tx) => {
        const result = await fn(tx);
        const rows = await tx.execute<{ x: string }>(
          sql`SELECT pg_current_xact_id()::text AS x`,
        );
        xid = rows.rows[0]!.x;
        return result;
      });
      return { value, xid };
    };
    try {
      const all: ResourceParams = {};
      await subscribe(taskRows.key, all);

      const created = await inTx((tx) =>
        createTask(
          { title: "demo write: created", mandate: mandatePolicy([]) },
          tx,
        ),
      );
      const id = created.value.id;
      // The created task reaches the collection's subscriber, acked by its xid.
      const createdFrame = await until(
        () =>
          frames.find(
            (f) =>
              isFor(f, taskRows.key, all) &&
              (f.kind === "delta" || f.kind === "update") &&
              f.ackTx?.includes(created.xid) === true,
          ),
        "the created task's frame",
      );
      expect(JSON.stringify(createdFrame)).toContain("demo write: created");

      const point = taskDescriptions.rows.point.encode([id]);
      await subscribe(taskDescriptions.rows.key, point);
      // A read started after the commit carries the database's snapshot
      // watermark, strictly above the write's xid: the backstop that confirms
      // an op whose exact ack the client missed.
      const ack = frames.find(
        (f) =>
          isFor(f, taskDescriptions.rows.key, point) && f.kind === "sub-ack",
      );
      expect(ack?.watermark).toMatch(/^\d+$/);
      expect(BigInt(ack!.watermark!) > BigInt(created.xid)).toBe(true);
      const updated = await inTx((tx) =>
        updateTask(
          id,
          { title: "demo write: renamed", description: "now described" },
          tx,
        ),
      );
      const renamed = await until(
        () =>
          frames.find(
            (f) =>
              isFor(f, taskRows.key, all) &&
              (f.kind === "delta" || f.kind === "update") &&
              f.ackTx?.includes(updated.xid) === true,
          ),
        "the renamed task's frame",
      );
      expect(JSON.stringify(renamed)).toContain("demo write: renamed");
      const described = await until(
        () =>
          frames.find(
            (f) =>
              isFor(f, taskDescriptions.rows.key, point) &&
              (f.kind === "delta" || f.kind === "update") &&
              f.ackTx?.includes(updated.xid) === true,
          ),
        "the task row's frame",
      );
      expect(JSON.stringify(described)).toContain("now described");
    } finally {
      ws.close(socket, 1000, "test");
    }
  });

  test("L2 persists in the worker, and its prune bounds the changelog", async () => {
    // The seed runs on the live host (after `onReady`), so a key persisted at
    // its first recompute may sit below every seed write: the floor bounds
    // the prune, whatever it is.
    const floor = async () =>
      (
        await db.execute<{ floor: string | null; rows: number }>(
          sql`SELECT min(position)::text AS floor, count(*)::int AS rows FROM live_state_snapshot`,
        )
      ).rows[0]!;
    const deadline = Date.now() + 10_000;
    let persisted = await floor();
    while (persisted.rows === 0) {
      if (Date.now() > deadline) {
        throw new Error("timed out waiting for L2 to persist a snapshot row");
      }
      await new Promise((r) => setTimeout(r, 20));
      persisted = await floor();
    }
    expect(persisted.floor).toMatch(/^\d+$/);
    const counts = async () =>
      (
        await db.execute<{ below: number; above: number }>(
          sql`SELECT
                count(*) FILTER (WHERE xid < (SELECT min(position) FROM live_state_snapshot))::int AS below,
                count(*) FILTER (WHERE xid >= (SELECT min(position) FROM live_state_snapshot))::int AS above
              FROM live_state_changelog`,
        )
      ).rows[0]!;
    // The seed's writes are in the changelog. Whether any of them sits under
    // the floor depends on when each key first persisted, so a row is planted
    // just under it: the prune must delete it, or this proves nothing.
    expect((await counts()).below + (await counts()).above).toBeGreaterThan(0);
    await db.execute(
      sql`INSERT INTO live_state_changelog (xid, t, op) VALUES (${persisted.floor}::numeric - 1, 'x', 'I')`,
    );
    const before = await counts();
    expect(before.below).toBeGreaterThan(0);
    await pruneChangelog(db);
    // Everything under the floor is gone; nothing at or above it is touched.
    expect(await counts()).toEqual({ below: 0, above: before.above });
  });

  // ── Prototypes: the tree a memory data-files root, seeded ──────────────────
  const prototypeSeed = parsePrototypeTree(diskDemoPrototypes().tree);
  const request = (method: string, path: string, body?: unknown) =>
    host.request(
      new Request(`http://demo.invalid${path}`, {
        method,
        ...(body === undefined
          ? {}
          : {
              body: JSON.stringify(body),
              headers: { "content-type": "application/json" },
            }),
      }),
    );

  test("the gallery lists the seeded prototypes, each read whole and well-formed", async () => {
    const list = (await loadResourceByKey(
      "prototypes.list",
      {},
    )) as PrototypeMeta[];
    expect(list.map((m) => m.name).sort()).toEqual(
      prototypeSeed.prototypes.map((p) => p.id).sort(),
    );
    for (const meta of list) expect(meta.problems).toEqual([]);
    const lumen = list.find((m) => m.name === DEMO_PINNED_PROTOTYPE)!;
    expect(lumen.options.map((o) => o.name)).toEqual(["density", "accent"]);
    // One mocks nothing, one an exhibit, one a route (compare's `unresolved` arm here).
    expect(
      [...list]
        .sort((a, b) => (a.name < b.name ? -1 : 1))
        .map((m) => m.mocks.kind),
    ).toEqual(["none", "declared", "declared"]);
  });

  test("a prototype's sibling files are served with their own types", async () => {
    const css = await request(
      "GET",
      `/api/prototypes/${DEMO_PINNED_PROTOTYPE}/styles.css`,
    );
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(await css.text()).toContain('url("leaf.svg")');
    const svg = await request(
      "GET",
      `/api/prototypes/${DEMO_PINNED_PROTOTYPE}/leaf.svg`,
    );
    expect(svg.status).toBe(200);
    expect(svg.headers.get("content-type")).toContain("image/svg+xml");
    // The document carries the user's pick, stamped onto its <html>.
    const doc = await request(
      "GET",
      `/api/prototypes/${DEMO_PINNED_PROTOTYPE}/index.html?accent=%2314b8a6`,
    );
    expect(doc.status).toBe(200);
    expect(await doc.text()).toContain("--accent: #14b8a6");
  });

  test("each seeded history holds its steps, and a version's files are served", async () => {
    for (const p of prototypeSeed.prototypes) {
      const history = (await loadResourceByKey("prototypes.history", {
        name: p.id,
      })) as PrototypeHistory;
      expect(history.dirty).toBe(false);
      expect(history.versions.map((v) => v.subject).slice(1)).toEqual(
        p.versions.slice(1).map((v) => v.subject),
      );
      const first = history.versions[0]!;
      const res = await request(
        "GET",
        `/api/prototypes/${p.id}/versions/${first.sha}/index.html`,
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(p.versions[0]!.files["index.html"] ?? "");
    }
    const counts = (await loadResourceByKey(
      "prototypes.versionCounts",
      {},
    )) as Record<string, number>;
    expect(counts).toEqual(
      Object.fromEntries(
        prototypeSeed.prototypes.map((p) => [p.id, p.versions.length]),
      ),
    );
  });

  test("the gallery's rows: the tags, each prototype's tag, the pin", async () => {
    const rows = await db.execute<{
      id: string;
      tag_id: string | null;
      pinned: boolean;
    }>(sql`SELECT id, tag_id, pinned FROM prototype_state ORDER BY id`);
    expect(rows.rows).toEqual(
      DEMO_PROTOTYPE_TAGS.flatMap((t) =>
        t.carriers.map((id) => ({
          id,
          tag_id: t.id,
          pinned: id === DEMO_PINNED_PROTOTYPE,
        })),
      ).sort((a, b) => (a.id < b.id ? -1 : 1)),
    );
  });

  test("every seeded prototype's thumbnail is ready, from the committed PNGs", async () => {
    const want = Object.fromEntries(
      prototypeSeed.prototypes.map((p) => [
        p.id,
        prototypeFixtureVersionFingerprint(p.versions.at(-1)!),
      ]),
    );
    // The sync runs from onReady, fire-and-forget: wait for its answer.
    const states = await until(async () => {
      const read = (await loadResourceByKey(
        "prototypes.thumbnails",
        {},
      )) as Record<string, ThumbnailState>;
      return Object.keys(want).every((id) => read[id] !== undefined)
        ? read
        : undefined;
    }, "every prototype's thumbnail state");
    for (const [id, key] of Object.entries(want)) {
      expect(states[id]).toEqual({ status: "ready", key });
      const png = await request("GET", `/api/prototype-thumbs/${key}.png`);
      expect(png.status).toBe(200);
      expect(png.headers.get("content-type")).toContain("image/png");
    }
  });

  test("minting a prototype needs the computer: declared needsMachine, refused here", async () => {
    expect(createPrototype.needsMachine).toBeDefined();
    const res = await request("POST", "/api/prototypes", { title: "x" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: "unsupported" });
  });

  test("a pick round-trips: the PUT writes the record, and its subscriber hears it", async () => {
    const frames: Frame[] = [];
    const socket = {
      send(raw: string) {
        const frame = JSON.parse(raw) as Frame;
        if (frame.kind !== "ping") frames.push(frame);
      },
    };
    const ws = host.notifications as unknown as {
      open(ws: unknown): void;
      message(ws: unknown, raw: string): void;
      close(ws: unknown, code: number, reason: string): void;
    };
    ws.open(socket);
    const params = { name: DEMO_PINNED_PROTOTYPE };
    try {
      ws.message(
        socket,
        JSON.stringify({ op: "sub", id: 1, key: "prototypes.picks", params }),
      );
      await until(
        () =>
          frames.some(
            (f) => isFor(f, "prototypes.picks", params) && f.kind === "sub-ack",
          ),
        "sub-ack prototypes.picks",
      );
      expect(await loadResourceByKey("prototypes.picks", params)).toEqual({
        accent: "#14b8a6",
      });
      const res = await request(
        "PUT",
        `/api/prototypes/${DEMO_PINNED_PROTOTYPE}/picks`,
        { kind: "set", option: "density", value: "compact" },
      );
      expect(res.status).toBeLessThan(300);
      const heard = await until(
        () =>
          frames.find(
            (f) =>
              isFor(f, "prototypes.picks", params) &&
              (f.kind === "delta" || f.kind === "update") &&
              JSON.stringify(f).includes("compact"),
          ),
        "the pick's frame",
      );
      expect(heard).toBeDefined();
      expect(await loadResourceByKey("prototypes.picks", params)).toEqual({
        accent: "#14b8a6",
        density: "compact",
      });
    } finally {
      ws.close(socket, 1000, "test");
    }
  });
});
