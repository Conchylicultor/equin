/**
 * `writePageTree` on a portable host with its triggers LIVE: what a written
 * tree derives — the backlinks edge of an inline page link, the search docs,
 * a history snapshot — comes from the `blocksChanged` consumers' own jobs, not
 * from the writer, and the tags and star it writes itself are read back.
 *
 * The graph is the portable `dependsOn` closure (from the app's server
 * registry) of the writer plus the consumers a written page reaches (links and its inline-link
 * extractor, the text and to-do blocks, Pages' content search and history),
 * and what a host without the computer boots beside it (`test-host`'s
 * `withPortableHost`: derived providers, the committed migrations and config,
 * memory host storage). Booted through `bootBrowserHost` — the browser host's
 * own boot (the graph portable by construction — derived from its closure,
 * nothing asserted at boot), then the post-ready phases (the
 * events' trigger sync, the in-process queue's start, the change feed's
 * LISTEN), then the settled phase (the boot warm-ups, awaited) — so a write runs its effects exactly as it does in the demo's
 * worker. `settleJobQueue` then runs the queue dry, the snapshot's 4 s
 * debounce fast-forwarded.
 *
 * Boots in a FRESH bun process (this file re-run as a child with
 * `PAGES_FIXTURES_BOOT_CHILD` set): a boot collects its own host-service
 * providers and registers its graph process-wide, which would leak into every
 * suite after it in the shared `bun test` process.
 *
 * Run: `./equin test plugins/apps/plugins/pages/plugins/fixtures`.
 */

import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { sql } from "drizzle-orm";
import { bootBrowserHost } from "@plugins/framework/plugins/server-core/core";
import {
  portableClosureOf,
  withPortableHost,
} from "@plugins/framework/plugins/browser-server/plugins/test-host/server/testing";
import { unmatchedApiResponse } from "@plugins/infra/plugins/endpoints/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { settleJobQueue } from "@plugins/infra/plugins/jobs/plugins/in-process/server";
import { db } from "@plugins/database/server";
import { blockIdKind } from "@plugins/page/plugins/editor/core";
import { EmojiSchema } from "@plugins/ui/plugins/icons/plugins/emoji/core";
import { pageLinkToken } from "@plugins/page/plugins/inline-page-link/core";
import { loadBacklinkSources } from "@plugins/page/plugins/links/server";
import { loadPageTags } from "@plugins/page/plugins/tags/server";
import type { PageTreeFixture } from "../../core";
import { writePageTree } from "./write-page-tree";

setDefaultTimeout(300_000);

const SUBJECT = "apps/plugins/pages/plugins/fixtures";

/** What a written page reaches: the `blocksChanged` consumers and the block types it holds. */
const CONSUMERS = [
  "page/plugins/links",
  "page/plugins/inline-page-link",
  "page/plugins/text",
  "page/plugins/to-do",
  "page/plugins/heading/plugins/heading-2",
  "page/plugins/bulleted-list",
  "apps/plugins/pages/plugins/content-search",
  "apps/plugins/pages/plugins/history",
];

/**
 * What a serving host boots beside its graph: the change feed, which the
 * post-ready phases require of any host serving DB-backed live reads, and its
 * companion pruner (`live-state-snapshot`'s `ChangelogRetention`), without
 * which the feed's `onReady` refuses to start.
 */
const HOST = [
  "network/plugins/live/plugins/change-feed",
  "network/plugins/live/plugins/live-state-snapshot",
];

const IN_CHILD = process.env.PAGES_FIXTURES_BOOT_CHILD === "1";

if (!IN_CHILD) {
  test("writePageTree derives through live triggers on a portable host (in a fresh process)", async () => {
    const result = await spawnCaptured(
      [process.execPath, "test", import.meta.path],
      {
        // The repo root, so the child reads the same bunfig (test preload).
        cwd: REPO_ROOT,
        // Its own graph: no desktop providers from the test preload.
        env: {
          ...process.env,
          PAGES_FIXTURES_BOOT_CHILD: "1",
          BOOTS_OWN_PLUGIN_GRAPH: "1",
        },
        timeoutMs: 240_000,
      },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `pages fixtures boot child exited ${result.exitCode}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
      );
    }
    expect(result.exitCode).toBe(0);
  });
}

const id = (n: number) =>
  blockIdKind.parse(`block-1760000000-fixt${String(n).padStart(2, "0")}`);

const HOME = id(1);
const SPEC = id(10);
const NOTES = id(20);
const LINKING_BLOCK = id(21);

/**
 * HOME "Atlas" (tagged, starred)
 * ├── text, to-do
 * └── SPEC "Atlas spec" (gradient cover) — text, a markdown run (heading,
 *     bullets, one nested and bold), text
 * NOTES "Notes"
 * └── text linking SPEC inline
 */
const TREE: PageTreeFixture = [
  {
    id: HOME,
    type: "page",
    title: "Atlas",
    icon: EmojiSchema.parse("🗺️"),
    tags: [{ name: "Fixture tag", color: "green" }],
    starred: true,
    children: [
      { id: id(2), type: "text", text: "A map of everything." },
      { id: id(3), type: "to-do", text: "Draw the coastline", checked: true },
      {
        id: SPEC,
        type: "page",
        title: "Atlas spec",
        cover: { type: "gradient", preset: "ocean" },
        children: [
          { id: id(11), type: "text", text: "Projections are cylindrical." },
          {
            type: "markdown",
            markdown: [
              "## Projections",
              "- Mercator",
              "  - **Web** Mercator",
            ].join("\n"),
          },
          { id: id(12), type: "text", text: "Distortion grows at the poles." },
        ],
      },
    ],
  },
  {
    id: NOTES,
    type: "page",
    title: "Notes",
    children: [
      {
        id: LINKING_BLOCK,
        type: "text",
        text: `See ${pageLinkToken(SPEC)} for the projection.`,
      },
    ],
  },
];

describe.if(IN_CHILD)("writePageTree on a portable host", () => {
  beforeAll(async () => {
    const host = await bootBrowserHost({
      entries: await withPortableHost(
        await portableClosureOf([SUBJECT, ...CONSUMERS, ...HOST]),
      ),
      onUnmatched: unmatchedApiResponse,
    });
    // The boot warm-ups (links and search backfills) run over the empty
    // corpus; let them land before the write.
    await host.settled;
    await writePageTree(TREE);
    await settleJobQueue();
  });

  test("the pages land in the forest, nested as the fixture nests them", async () => {
    const rows = await db.execute<{
      id: string;
      parent_id: string | null;
      title: string;
      icon: string | null;
    }>(
      sql`SELECT id, parent_id, data->>'title' AS title, data->>'icon' AS icon FROM page_blocks
          WHERE type = 'page' AND deleted_at IS NULL ORDER BY id`,
    );
    expect(rows.rows).toEqual([
      { id: HOME, parent_id: null, title: "Atlas", icon: "🗺️" },
      { id: SPEC, parent_id: HOME, title: "Atlas spec", icon: null },
      { id: NOTES, parent_id: null, title: "Notes", icon: null },
    ]);
  });

  test("a markdown run lands as parsed blocks, in place, under the caller's own", async () => {
    const rows = await db.execute<{
      id: string;
      parent_id: string;
      type: string;
      data: { text?: { text: string; marks?: string[] }[] };
    }>(
      sql`SELECT id, parent_id, type, data FROM page_blocks
          WHERE page_id = ${SPEC} AND deleted_at IS NULL ORDER BY parent_id, rank`,
    );
    const top = rows.rows.filter((r) => r.parent_id === SPEC);
    expect(top.map((r) => r.type)).toEqual([
      "text",
      "heading-2",
      "bulleted-list",
      "text",
    ]);
    expect([top[0]!.id, top[3]!.id]).toEqual([id(11), id(12)]);
    const nested = rows.rows.filter((r) => r.parent_id === top[2]!.id);
    expect(nested.map((r) => r.type)).toEqual(["bulleted-list"]);
    expect(nested[0]!.data.text).toEqual([
      { text: "Web", marks: ["bold"] },
      { text: " Mercator" },
    ]);
    const cover = await db.execute<{ cover: unknown }>(
      sql`SELECT data->'cover' AS cover FROM page_blocks WHERE id = ${SPEC}`,
    );
    expect(cover.rows[0]?.cover).toEqual({ type: "gradient", preset: "ocean" });
  });

  test("the inline page link derived its backlinks edge", async () => {
    expect(await loadBacklinkSources(SPEC)).toEqual([
      expect.objectContaining({ id: NOTES, title: "Notes" }),
    ]);
    const edges = await db.execute<{ source_block_id: string }>(
      sql`SELECT source_block_id FROM page_links
          WHERE source_page_id = ${NOTES} AND target_page_id = ${SPEC}`,
    );
    expect(edges.rows).toEqual([{ source_block_id: LINKING_BLOCK }]);
  });

  test("every page derived its search document", async () => {
    const docs = await db.execute<{
      entity_id: string;
      title: string;
      body: string;
    }>(
      sql`SELECT entity_id, title, body FROM search_documents ORDER BY entity_id`,
    );
    expect(docs.rows.map((d) => [d.entity_id, d.title])).toEqual([
      [HOME, "Atlas"],
      [SPEC, "Atlas spec"],
      [NOTES, "Notes"],
    ]);
    expect(docs.rows.find((d) => d.entity_id === SPEC)?.body).toContain(
      "Projections are cylindrical.",
    );
  });

  test("every page derived a history snapshot", async () => {
    const versions = await db.execute<{ entity_id: string }>(
      sql`SELECT DISTINCT entity_id FROM entity_versions
          WHERE source_id = 'pages' ORDER BY entity_id`,
    );
    expect(versions.rows.map((v) => v.entity_id)).toEqual([HOME, SPEC, NOTES]);
  });

  test("the tags and the star are written", async () => {
    expect(
      (await loadPageTags(HOME)).map((t) => ({ name: t.name, color: t.color })),
    ).toEqual([{ name: "Fixture tag", color: "green" }]);
    expect(await loadPageTags(NOTES)).toEqual([]);
    const starred = await db.execute<{ parent_id: string }>(
      sql`SELECT parent_id FROM page_blocks_ext_starred`,
    );
    expect(starred.rows).toEqual([{ parent_id: HOME }]);
  });
});
