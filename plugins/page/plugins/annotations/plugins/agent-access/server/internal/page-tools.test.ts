/**
 * The page tools as portable functions: agent-access's server closure BOOTS
 * with no desktop machine half in the graph, on PGlite, and `pageTools` answers
 * there exactly as the MCP tools (`machine/internal/mcp-tools.ts`, thin wrappers
 * over it) answer an agent — `read` the redacted markdown, `edit` the
 * `applySummary` JSON with the tool's own fields, the author stamped, and a
 * write outside every agent-authored block refused with nothing written.
 *
 * The graph is agent-access's `dependsOn` closure from the app's server
 * registry, plus the plain text block (a page needs one to hold prose), the
 * providers of a host without the computer, and the committed migration
 * history read off disk — the harness of `tasks/task-category`'s portable-boot
 * suite. Only the graph under test must be portable, not this harness.
 *
 * Boots in a FRESH bun process (this file re-run as a child with
 * `PAGE_TOOLS_BOOT_CHILD` set): a boot collects its own host-service providers
 * and registers its graph process-wide, which would leak into every suite after
 * it in the shared `bun test` process.
 *
 * Run: `./equin test plugins/page/plugins/annotations/plugins/agent-access`.
 */

import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  bootPluginGraph,
  serverEntries,
  serverEntryFor,
} from "@plugins/framework/plugins/server-core/core/testing";
import { PLUGINS_DIR, REPO_ROOT } from "@plugins/infra/plugins/paths/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import { db } from "@plugins/database/server";
import {
  isMigrationFileName,
  migrationsFrom,
  MigrationSource,
} from "@plugins/database/plugins/migrations/server";
import { pageTools } from "./page-tools";

setDefaultTimeout(300_000);

type Entry = (typeof serverEntries)[number];

const SUBJECT = "page/plugins/annotations/plugins/agent-access";

// The portable providers, as registry entries: none is in the app's registry
// (`base-exclusions` keeps them out of every desktop composition).
const PROVIDERS: Entry[] = [
  serverEntryFor("database/plugins/pglite", ["database"]),
  serverEntryFor("infra/plugins/jobs/plugins/in-process", [
    "infra/plugins/jobs",
    "database",
  ]),
  serverEntryFor("primitives/plugins/log-channels/plugins/memory-persistence", [
    "primitives/plugins/log-channels",
  ]),
  serverEntryFor("infra/plugins/warmup/plugins/sole-host", [
    "infra/plugins/warmup",
  ]),
];

// The committed migration history, read off disk by THIS harness.
const MIGRATIONS_DATA = join(PLUGINS_DIR, "database/plugins/migrations/data");
const migrationSource: Entry = {
  pluginPath: `${SUBJECT}/page-tools-boot-migrations`,
  id: "page.annotations.agent-access.page-tools-boot-migrations",
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

/** The `dependsOn` closure of `roots` in the app's server registry. */
function closureOf(roots: string[]): Entry[] {
  const byPath = new Map(serverEntries.map((e) => [e.pluginPath, e]));
  const seen = new Set<string>();
  const stack = [...roots];
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

const IN_CHILD = process.env.PAGE_TOOLS_BOOT_CHILD === "1";

if (!IN_CHILD) {
  test("pageTools runs on agent-access's portable closure (in a fresh process)", async () => {
    const result = await spawnCaptured(
      [process.execPath, "test", import.meta.path],
      {
        // The repo root, so the child reads the same bunfig (test preload).
        cwd: REPO_ROOT,
        // Its own graph: no desktop providers from the test preload.
        env: {
          ...process.env,
          PAGE_TOOLS_BOOT_CHILD: "1",
          BOOTS_OWN_PLUGIN_GRAPH: "1",
        },
        timeoutMs: 240_000,
      },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `page-tools boot child exited ${result.exitCode}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
      );
    }
    expect(result.exitCode).toBe(0);
  });
}

const CONVERSATION = "conv-page-tools-test";
const text = (s: string) => ({ text: [{ text: s }] });

/**
 * PAGE (page)              — "Notes"
 * ├── PROSE                "The parser handles UTF-8."
 * └── CARD <agent-inline>
 *     └── CARD-1           "Checked the writer."
 */
const ROWS = [
  {
    id: "PAGE",
    parent: null,
    page: null,
    type: "page",
    rank: "a0",
    data: { title: "Notes", icon: null },
  },
  {
    id: "PROSE",
    parent: "PAGE",
    page: "PAGE",
    type: "text",
    rank: "a0",
    data: text("The parser handles UTF-8."),
  },
  {
    id: "CARD",
    parent: "PAGE",
    page: "PAGE",
    type: "agent-note",
    rank: "a1",
    data: {},
  },
  {
    id: "CARD-1",
    parent: "CARD",
    page: "PAGE",
    type: "text",
    rank: "a0",
    data: text("Checked the writer."),
  },
];

const caller = { conversationId: CONVERSATION };

describe.if(IN_CHILD)("pageTools on a portable host", () => {
  beforeAll(async () => {
    await bootPluginGraph({
      mode: "exec",
      entries: [
        ...closureOf([SUBJECT, "page/plugins/text"]),
        ...PROVIDERS,
        migrationSource,
      ],
      hasCoreBarrel: (pluginPath) =>
        existsSync(join(PLUGINS_DIR, pluginPath, "core", "index.ts")),
    });
    for (const r of ROWS) {
      await db.execute(
        sql`INSERT INTO page_blocks (id, parent_id, page_id, type, rank, data)
            VALUES (${r.id}, ${r.parent}, ${r.page}, ${r.type}, ${r.rank},
                    ${JSON.stringify(r.data)}::jsonb)`,
      );
    }
  });

  test("read returns the page as read_page does: header, title, card by id", async () => {
    const [part] = (await pageTools.read({ block_id: "PAGE" }, caller)).content;
    expect(part.type).toBe("text");
    expect(part.text).toStartWith('<page-meta kind="page"');
    expect(part.text).toEndWith(
      "# Notes\n\nThe parser handles UTF-8.\n" +
        '<agent-inline id="CARD">\n  Checked the writer.\n</agent-inline>',
    );
  });

  test("edit inside the card answers with the applySummary fields, and stamps the card", async () => {
    const result = await pageTools.edit(
      {
        block_id: "PAGE",
        old_string: "Checked the writer.",
        new_string: "Checked the writer and the reader.",
        replace_all: false,
      },
      caller,
    );
    expect(JSON.parse(result.content[0].text)).toEqual({
      scope_id: "PAGE",
      page_id: "PAGE",
      note_ids: ["CARD"],
      survived: expect.any(Number),
      created: 0,
      deleted: 0,
      moved: 0,
      text_edited: 1,
      created_ids: [],
      created_page_ids: [],
      absorbed_writes: expect.any(Number),
      replaced: 1,
    });
    const stamps = await db.execute<{ block_id: string }>(
      sql`SELECT block_id FROM page_blocks_agent_authors
          WHERE conversation_id = ${CONVERSATION}`,
    );
    expect(stamps.rows.map((r) => r.block_id)).toEqual(["CARD"]);
  });

  test("edit of the page's own prose is refused, and writes nothing", async () => {
    const refusal = await pageTools
      .edit(
        {
          block_id: "PAGE",
          old_string: "The parser handles UTF-8.",
          new_string: "The parser handles UTF-16.",
          replace_all: false,
        },
        caller,
      )
      .then(
        () => null,
        (err: unknown) => {
          if (err instanceof HttpError) return err;
          throw err;
        },
      );
    expect(refusal?.status).toBe(403);
    const [part] = (await pageTools.read({ block_id: "PAGE" }, caller)).content;
    expect(part.text).toContain("The parser handles UTF-8.");
  });
});
