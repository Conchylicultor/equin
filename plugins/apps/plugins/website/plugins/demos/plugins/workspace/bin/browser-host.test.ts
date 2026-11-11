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
 * `import.meta.glob`, which Bun cannot evaluate): the migration history and the
 * committed config layer are provided by the same data read off disk, as the
 * build does when it takes the demo's snapshot (`./bun-host.ts`). Every other
 * entry is the graph the worker boots.
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
 * The settled phase runs in the worker too: the warm-ups drained (host-scoped
 * ones included — a sole host runs every scope) and the retention sweeps are
 * mounted, one of them run through the in-process queue against PGlite.
 *
 * Run: `./equin test plugins/apps/plugins/website/plugins/demos/plugins/workspace`.
 */

import { defineMandate } from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/policy/core";
import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";
import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { declareMemoryHostStorage } from "@plugins/framework/plugins/browser-server/plugins/host-storage/core/testing";
import * as fs from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
} from "@plugins/framework/plugins/server-core/core";
import { unmatchedApiResponse } from "@plugins/infra/plugins/endpoints/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { injectFrameAgent } from "@plugins/primitives/plugins/embed/plugins/frame/plugins/agent/core";
import {
  appScopeId,
  committedDocument,
  readCommittedFilesSync,
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
  ConfigStore,
  getAllDescriptors,
  setConfigByPath,
} from "@plugins/config_v2/server";
import { systemOrigin } from "@plugins/infra/plugins/request-origin/core";
import { sql } from "drizzle-orm";
import { dataViewStorePath } from "@plugins/primitives/plugins/data-view/server";
import { db } from "@plugins/database/server";
import { pruneChangelog } from "@plugins/network/plugins/live/plugins/live-state-snapshot/server/testing";
import {
  createTask,
  updateTask,
} from "@plugins/tasks/plugins/tasks-core/server";
import {
  taskDescriptions,
  taskRows,
} from "@plugins/tasks/plugins/tasks-core/core";
import {
  PRACTICE_TIMER_PAGE_WORK,
  DEMO_AGENTS,
  DEMO_PAGE_IDS,
  DEMO_PLACES,
  DEMO_STORIES,
  demoAgentId,
  demoConversationId,
  demoPromptOf,
  demoStoryByKey,
  demoTaskId,
} from "@plugins/apps/plugins/website/plugins/demos/plugins/workspace/plugins/story/core";
import type { ToolCallEvent } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import { parsePageApplyReport } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/plugins/page-tools/core";
import { readBlockAsMarkdown } from "@plugins/page/plugins/markdown-apply/server";
import { pageTools } from "@plugins/page/plugins/annotations/plugins/agent-access/server";
import { loadPageTags } from "@plugins/page/plugins/tags/server";
import { promptBlock } from "@plugins/page/plugins/prompt/plugins/link/server";
import { PAGES_CATEGORY_ID } from "@plugins/page/plugins/prompt/plugins/link/core";
import { searchResults } from "@plugins/search/plugins/engine/core";
import { warmupRunOf } from "@plugins/infra/plugins/warmup/server";
import { listRegisteredJobs } from "@plugins/infra/plugins/jobs/server";
import { settleJobQueue } from "@plugins/infra/plugins/jobs/plugins/in-process/server";
import { hostReads } from "../core/browser-host.generated";
import { conversationTurns } from "@plugins/conversations/plugins/turn-ledger/core";
import { DEMO_CONVERSATION_ID } from "../core/internal/scenario";
import { bunHostEntries, diskDemoData } from "./bun-host";
import { seed } from "./seed";
import {
  DEMO_FEATURED_PROTOTYPE,
  DEMO_FILE_SONGS,
  DEMO_PROTOTYPE_TAGS,
  DEMO_SONGS,
} from "@plugins/apps/plugins/website/plugins/demos/plugins/workspace/plugins/story/core/testing";
import {
  parsePrototypeTree,
  prototypeFixtureVersionFingerprint,
} from "@plugins/apps/plugins/prototypes/plugins/fixtures/core";
import {
  createPrototype,
  type PrototypeHistory,
  type PrototypeMeta,
} from "@plugins/apps/plugins/prototypes/plugins/files/core";
import type { ThumbnailState } from "@plugins/apps/plugins/prototypes/plugins/thumbnails/core";

// Any registered mandate id: these tests never resolve it.
const TEST_MANDATE = defineMandate({ id: "interactive", label: "Interactive" });

setDefaultTimeout(300_000);

// The committed layer the bundled layer inlines, read off disk.
const committedFiles = readCommittedFilesSync(join(REPO_ROOT, "config"), fs);

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
    // A browser host keeps its state where its entry point declares; here, in memory.
    declareMemoryHostStorage();
    // The worker's own boot (`./browser-host.ts`): browser mode over a graph
    // portable by construction (derived at build), the resource key set closed.
    host = await bootBrowserHost({
      entries: bunHostEntries(),
      seed: (h) => seed(diskDemoData(), h),
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
    const rows = (await loadResourceByKey(
      taskRows.rows.key,
      taskRows.rows.point.encode(DEMO_STORIES.map(demoTaskId)),
    )) as Row[];
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

  /** A conversation's events (the open one's by default), oldest first, as the real parser reads its JSONL. */
  async function openConversationEvents(
    id: string = DEMO_CONVERSATION_ID,
  ): Promise<
    ({ kind: string; name?: string; text?: string } | ToolCallEvent)[]
  > {
    // One page as large as the ceiling: the whole (short) transcript, newest first.
    const rows = (await loadResourceByKey(
      jsonlEvents.key,
      jsonlEvents.query.encode(
        { id },
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
    const names = events
      .filter((e) => e.kind === "tool-call")
      .map((e) => e.name);
    // It reads the page it was launched from and the spec first, writes its
    // plan on the page, works in code, and ends rewriting its card.
    expect(names.slice(0, 2)).toEqual([
      "mcp__equin__read_page",
      "mcp__equin__read_page",
    ]);
    expect(names).toContain("mcp__equin__edit_page");
    expect(names).toEqual(
      expect.arrayContaining(["Grep", "Read", "Edit", "Write", "Bash"]),
    );
    expect(names.at(-1)).toBe("mcp__equin__write_agent_note");
    expect(events.at(-1)?.kind).toBe("assistant-text");
  });

  test("every story's session reads as a real one: several turns, tool calls, an ending for its state", async () => {
    for (const story of DEMO_STORIES) {
      const events = await openConversationEvents(`conv-demo-${story.key}`);
      const calls = events.filter((e) => e.kind === "tool-call");
      expect(events[0]?.kind).toBe("user-text");
      expect(calls.length).toBeGreaterThanOrEqual(3);
      // An agent at work ends on a tool call still running; any other on its answer.
      expect(events.at(-1)?.kind).toBe(
        story.status === "working" ? "tool-call" : "assistant-text",
      );
    }
  });

  test("the weekly-review agent's Journal read is the real tool's", async () => {
    const [readJournal] = (
      await openConversationEvents("conv-demo-weekly-review")
    ).filter(
      (e): e is ToolCallEvent =>
        e.kind === "tool-call" && (e.name ?? "").endsWith("read_page"),
    );
    const reread = await pageTools.read(
      { block_id: DEMO_PAGE_IDS.journal },
      { conversationId: "conv-demo-weekly-review" },
    );
    expect(readJournal!.result?.content).toBe(reread.content[0].text);
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

  test("Demo's workspace: its pages, their hierarchy, and the page the agent minted", async () => {
    const pages = await livePages();
    const { welcome, practice, spec, blockTour, journal, ideas } =
      DEMO_PAGE_IDS;
    expect(pages.get(welcome)).toEqual([null, null, "Welcome to equin"]);
    expect(pages.get(practice)).toEqual([null, null, "Piano practice"]);
    expect(pages.get(blockTour)).toEqual([null, null, "Block tour"]);
    expect(pages.get(journal)).toEqual([null, null, "Journal"]);
    expect(pages.get(ideas)).toEqual([null, null, "Ideas"]);
    expect(pages.get(spec)).toEqual([
      practice,
      practice,
      "Practice timer spec",
    ]);
    const seeded = new Set<string>([
      welcome,
      practice,
      spec,
      blockTour,
      journal,
      ideas,
    ]);
    const minted = [...pages].filter(([id]) => !seeded.has(id));
    expect(minted.map(([, v]) => v)).toEqual([
      [practice, practice, PRACTICE_TIMER_PAGE_WORK.planTitle],
    ]);
  });

  test("the pages show the editor's block types, written from their markdown", async () => {
    const types = await db.execute<{ type: string }>(
      sql`SELECT DISTINCT type FROM page_blocks WHERE deleted_at IS NULL ORDER BY type`,
    );
    expect(types.rows.map((r) => r.type)).toEqual(
      expect.arrayContaining([
        "heading-1",
        "heading-2",
        "heading-3",
        "text",
        "bulleted-list",
        "numbered-list",
        "to-do",
        "toggle",
        "callout",
        "quote",
        "code-block",
        "table",
        "equation",
        "divider",
        "page-link",
        "prototype",
        "instructions",
        "prompt",
        "agent-note",
      ]),
    );
    const cover = await db.execute<{ preset: string }>(
      sql`SELECT data->'cover'->>'preset' AS preset FROM page_blocks WHERE id = ${DEMO_PAGE_IDS.welcome}`,
    );
    expect(cover.rows[0]?.preset).toBe("aurora");
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
    expect(pages).toHaveLength(7);
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

  test("the backlinks index holds the inline link from Piano practice to the spec", async () => {
    const edges = await db.execute<{ source: string; target: string }>(
      sql`SELECT source_page_id AS source, target_page_id AS target FROM page_links`,
    );
    expect(edges.rows).toContainEqual({
      source: DEMO_PAGE_IDS.practice,
      target: DEMO_PAGE_IDS.spec,
    });
  });

  test("the pages carry their tags and Welcome its star", async () => {
    expect(
      (await loadPageTags(DEMO_PAGE_IDS.practice)).map((t) => t.name),
    ).toEqual(["In progress"]);
    const starred = await db.execute<{ id: string }>(
      sql`SELECT parent_id AS id FROM page_blocks_ext_starred`,
    );
    expect(starred.rows.map((r) => r.id)).toEqual([DEMO_PAGE_IDS.welcome]);
  });

  test("the practice-timer task was launched from Piano practice's prompt block", async () => {
    const story = demoStoryByKey("practice-timer");
    expect(story.category).toBe(PAGES_CATEGORY_ID);
    expect(await promptBlock.get(demoTaskId(story))).toMatchObject({
      pageId: DEMO_PAGE_IDS.practice,
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
      demoPromptOf(demoStoryByKey("practice-timer")),
    );
    // Piano practice's instructions card reached the agent with its first read.
    expect(readOrigin!.result?.content).toContain("<received-instructions>");

    const [edit] = await toolCalls("edit_page");
    const report = parsePageApplyReport(edit!);
    expect(report).not.toBeNull();
    expect(report!.page_id).toBe(DEMO_PAGE_IDS.practice);
    expect(report!.replaced).toBe(1);
    const pages = await livePages();
    const plan = [...pages].find(
      ([, v]) => v[2] === PRACTICE_TIMER_PAGE_WORK.planTitle,
    )![0];
    expect(report!.created_page_ids).toEqual([plan]);
    expect(report!.note_ids).toHaveLength(2);
    const [card, page] = report!.note_ids as [string, string];
    expect(page).toBe(plan);

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
        [plan, DEMO_CONVERSATION_ID],
      ].sort(),
    );
    // The card holds the note's final contents, and the agent page is the agent's.
    const cardRead = await readBlockAsMarkdown(card!);
    expect(cardRead).toContain(PRACTICE_TIMER_PAGE_WORK.cardDone);
  });

  test("full-text search finds a seeded page on PGlite", async () => {
    const hits = (await loadResourceByKey(
      searchResults.key,
      searchResults.query.encode({
        q: "practice timer spec",
        sources: ["pages"],
      }),
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
      const origin = await store.read({ storePath, file: "origin" });
      if (JSON.stringify(origin?.content) !== JSON.stringify(doc.base))
        mismatched.push(`${storePath}: base origin differs`);
      for (const [appId, scoped] of Object.entries(doc.scopes)) {
        const scopeId = appScopeId(appId);
        const read = await store.read({ storePath, scopeId, file: "origin" });
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
    expect((await store.read({ storePath, file: "override" }))?.hash).toBe(
      (await store.read({ storePath, file: "origin" }))?.hash,
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

    const tracks = (await loadResourceByKey("task-tracks.by-id:rows", {
      ids,
    })) as {
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
      await loadResourceByKey("data-view-custom-values.v2", {
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
      // The tasks window's default page: the demo's few tasks, and the one
      // created below.
      const all: ResourceParams = taskRows.window.defaultParams;
      await subscribe(taskRows.key, all);

      const created = await inTx((tx) =>
        createTask({ title: "demo write: created", mandate: TEST_MANDATE }, tx),
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

  // ── The settled phase: warm-ups and retention, as on the desktop ─────────
  test("the settled phase drained the warm-ups, host-scoped ones included", async () => {
    await host.settled;
    // Worktree-scoped (the pages search and links backfills) and host-scoped
    // (auto-start's disarm sweep): a sole host runs every scope, so none is
    // skipped and each ran to success.
    for (const name of [
      "pages.search.backfill",
      "page.links.backfill",
      "tasks.auto-start-disarm-sweep",
    ]) {
      expect({ name, outcome: warmupRunOf(name)?.outcome }).toEqual({
        name,
        outcome: "succeeded",
      });
    }
  });

  test("the retention sweeps folded off machine/ are registered, and one sweeps on PGlite", async () => {
    const names = new Set(listRegisteredJobs().map((j) => j.name));
    for (const table of [
      "app_usage_daily",
      "usage_stats",
      "entity_versions",
      "trash_entries",
      "pending_questions",
      "conversation_turns",
    ]) {
      expect({ table, registered: names.has(`retention.${table}`) }).toEqual({
        table,
        registered: true,
      });
    }
    // One sweep through the in-process queue: a row older than the TTL goes,
    // a fresh one stays.
    await db.execute(
      sql`INSERT INTO app_usage_daily (usage_key, day, app_id, last_flushed_at) VALUES
            ('2020-01-01:retention-test', '2020-01-01', 'retention-test', now() - interval '3 years'),
            ('2026-01-01:retention-test', '2026-01-01', 'retention-test', now())`,
    );
    const sweep = listRegisteredJobs().find(
      (j) => j.name === "retention.app_usage_daily",
    );
    await sweep!.enqueue({});
    await settleJobQueue();
    const left = await db.execute<{ usage_key: string }>(
      sql`SELECT usage_key FROM app_usage_daily WHERE app_id = 'retention-test'`,
    );
    expect(left.rows).toEqual([{ usage_key: "2026-01-01:retention-test" }]);
  });

  // ── Prototypes: the tree a memory data-files root, seeded ──────────────────
  const prototypeSeed = parsePrototypeTree(diskDemoData().prototypes.tree);
  /** The seeded prototypes that mock a real app surface (Menu, Miller columns). */
  const MOCKING_PROTOTYPES = [
    "proto-1792900060-demo02",
    "proto-1792900300-demo06",
  ];
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
    const featured = list.find((m) => m.name === DEMO_FEATURED_PROTOTYPE)!;
    expect(featured.options.map((o) => o.name)).toEqual(["accent"]);
    // Menu mocks an exhibit, Miller columns the app at a route (compare's
    // `unresolved` arm here); the others stand on their own.
    expect(
      list
        .filter((m) => m.mocks.kind !== "none")
        .map((m) => m.name)
        .sort(),
    ).toEqual(MOCKING_PROTOTYPES);
  });

  test("a prototype's sibling files are served with their own types", async () => {
    const photos = await request(
      "GET",
      `/api/prototypes/${DEMO_FEATURED_PROTOTYPE}/photos.js`,
    );
    expect(photos.status).toBe(200);
    expect(photos.headers.get("content-type")).toContain("javascript");
    expect(await photos.text()).toStartWith("window.PHOTOS = {");
    // The document carries the user's pick, stamped onto its <html>.
    const doc = await request(
      "GET",
      `/api/prototypes/${DEMO_FEATURED_PROTOTYPE}/index.html?accent=%232f6f8f`,
    );
    expect(doc.status).toBe(200);
    expect(await doc.text()).toContain("--accent: #2f6f8f");
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
      // A content route's HTML carries the frame agent (content isolation):
      // the author's bytes, with the agent injected once at the head.
      expect(await res.text()).toBe(
        injectFrameAgent(p.versions[0]!.files["index.html"] ?? ""),
      );
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

  test("the gallery's rows: the tags, each prototype's tag", async () => {
    const rows = await db.execute<{
      id: string;
      tag_id: string | null;
    }>(sql`SELECT id, tag_id FROM prototype_state ORDER BY id`);
    expect(rows.rows).toEqual(
      DEMO_PROTOTYPE_TAGS.flatMap((t) =>
        t.carriers.map((id) => ({ id, tag_id: t.id })),
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
    // The sync is a warm-up, drained once the host settles: wait for its answer.
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
    const params = { name: DEMO_FEATURED_PROTOTYPE };
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
        accent: "#c8553d",
      });
      const res = await request(
        "PUT",
        `/api/prototypes/${DEMO_FEATURED_PROTOTYPE}/picks`,
        { kind: "set", option: "accent", value: "#2f6f8f" },
      );
      expect(res.status).toBeLessThan(300);
      const heard = await until(
        () =>
          frames.find(
            (f) =>
              isFor(f, "prototypes.picks", params) &&
              (f.kind === "delta" || f.kind === "update") &&
              JSON.stringify(f).includes("#2f6f8f"),
          ),
        "the pick's frame",
      );
      expect(heard).toBeDefined();
      expect(await loadResourceByKey("prototypes.picks", params)).toEqual({
        accent: "#2f6f8f",
      });
    } finally {
      ws.close(socket, 1000, "test");
    }
  });
  // ── Sonata: the library seeded, its reads and routes on the worker ─────────
  test("the library holds the demo's songs and the MIDI starters", async () => {
    const songs = await db.execute<{
      id: string;
      title: string;
      source: string;
    }>(sql`SELECT id, title, source FROM sonata_songs ORDER BY id`);
    for (const song of DEMO_SONGS) {
      expect(songs.rows).toContainEqual({
        id: song.id,
        title: song.title,
        source: "chord-grid",
      });
    }
    // The real pieces, each its file's source, named as the story names it.
    for (const song of DEMO_FILE_SONGS) {
      expect(songs.rows).toContainEqual({
        id: song.id,
        title: song.title,
        source: song.kind,
      });
    }
    // A fresh install's starters, seeded by the MIDI source itself.
    expect(
      songs.rows.filter((r) => r.source === "midi" && r.id.startsWith("seed-"))
        .length,
    ).toBeGreaterThan(0);
    const grids = await db.execute<{ song_id: string; chord_text: string }>(
      sql`SELECT parent_id AS song_id, chord_text FROM sonata_songs_ext_chord_grid ORDER BY parent_id`,
    );
    for (const song of DEMO_SONGS) {
      expect(grids.rows).toContainEqual({
        song_id: song.id,
        chord_text: song.chordText,
      });
    }
  });

  test("a MIDI starter's cover is drawn and cached on the worker", async () => {
    const [starter] = (
      await db.execute<{ id: string; changed: Date }>(
        sql`SELECT id, sources_changed_at AS changed FROM sonata_songs WHERE source = 'midi' ORDER BY id LIMIT 1`,
      )
    ).rows;
    const version = new Date(starter!.changed).getTime();
    for (let i = 0; i < 2; i++) {
      const res = await request(
        "GET",
        `/api/sonata/songs/${starter!.id}/midi/cover/${version}.svg`,
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<svg");
    }
  });

  test("the asset mirror is served here: an unknown mirror is its own 404", async () => {
    const res = await request("GET", "/api/asset-mirror/no-such-mirror/x.ogg");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("unknown mirror");
  });

  test("watching MIDI folders needs the computer: declared needsMachine, refused here", async () => {
    const res = await request("POST", "/api/sonata/midi-folders/recheck");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: "unsupported" });
  });

  // ── Places: the map's places and tags seeded, Google's half refused ───────
  test("the map holds the demo's places, on the starter tree plus Demo's tags", async () => {
    const places = await db.execute<{
      id: string;
      name: string;
      icon: string | null;
      tags: string[];
    }>(sql`SELECT id, name, icon, tags FROM places ORDER BY id`);
    expect(places.rows.map((r) => r.id)).toEqual(
      DEMO_PLACES.places.map((p) => p.id),
    );
    for (const place of DEMO_PLACES.places) {
      const row = places.rows.find((r) => r.id === place.id)!;
      expect(row.name).toBe(place.place.name);
      expect(row.icon).toBe(place.icon);
      expect(row.tags.length).toBe(place.tags.length);
    }
    const tags = await db.execute<{
      id: string;
      name: string;
      parent_id: string | null;
      color: string | null;
      role: string | null;
    }>(sql`SELECT id, name, parent_id, color, role FROM place_tags`);
    const trips = tags.rows.find((t) => t.name === "Trips")!;
    expect(trips.color).toBe("#0ea5e9");
    const lisbon = tags.rows.find((t) => t.name === "Lisbon")!;
    expect(lisbon.parent_id).toBe(trips.id);
    // The starter tree is there too, its role tags included.
    expect(
      tags.rows
        .filter((t) => t.role !== null)
        .map((t) => t.role)
        .sort(),
    ).toEqual(["been", "want"]);
    // The Lisbon trip's places are on it; most of the map is Demo's Paris.
    const onTrip = DEMO_PLACES.places.filter((p) =>
      p.tags.some((t) => t.join("/") === "Trips/Lisbon"),
    );
    expect(
      places.rows.filter((r) => r.tags.includes(lisbon.id)).map((r) => r.id),
    ).toEqual(onTrip.map((p) => p.id));
    expect(onTrip.length).toBeLessThan(DEMO_PLACES.places.length / 10);
  });

  test("the map's presets: All places, then Demo's saved ones, each a tag filter", async () => {
    const doc = (await loadResourceByKey(configValues.key, {
      path: dataViewStorePath("places.presets"),
    })) as { views: { id: string; view: { filter?: unknown } }[] };
    expect(doc.views.map((v) => v.id)).toEqual([
      "all",
      ...(DEMO_PLACES.presets ?? []).map((p) => p.id),
    ]);
    for (const view of doc.views.slice(1))
      expect(JSON.stringify(view.view.filter)).toContain("has-nested");
  });

  test("the map's browser key comes from the page: with no page, it reads unset", async () => {
    expect(await loadResourceByKey("google-maps.browser-config", {})).toEqual({
      kind: "unset",
    });
  });

  test("Google's half of Places needs the computer: declared needsMachine, refused here", async () => {
    for (const [method, path] of [
      ["POST", "/api/places/places"],
      ["POST", "/api/places/places/place-1792900000-demo001/icon"],
      ["GET", "/api/places/photo?name=places%2Fx%2Fphotos%2Fy"],
      ["GET", "/api/places/thumbnail?id=ChIJ"],
      ["POST", "/api/google-maps/browser-config"],
    ] as const) {
      const res = await request(method, path);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ reason: "unsupported" });
    }
  });
});
