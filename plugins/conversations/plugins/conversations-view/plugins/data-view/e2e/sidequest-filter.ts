/**
 * Every conversation list filters and groups by its task's TRACK — the field
 * task-track EXPOSES once (phase 1 of fields-declared-once,
 * research/2026-10-12-global-fields-declared-once-phase1.md), named by no
 * list:
 *
 *  1. seeds two tasks, each with an attempt and a closed `user` conversation:
 *     one on the sidequest track (a `tasks_ext_track` row), one on main (no
 *     row);
 *  2. adds one view per list to the deploy's runtime config of the lists —
 *     Queue and History (the sidebar's merged DataView) and All-conversations — each
 *     filtered `Track is any of Sidequest` and grouped by Track, then opens it
 *     (its `active-view` key);
 *  3. on each: the sidequest conversation is listed, the main one is not, and
 *     the one group header is Sidequest;
 *  4. History and All-conversations are LIVE lists: the server filters them —
 *     a frame of the list carries the exposed column's wire name
 *     (`tasks_ext_track.track`); the Queue filters its in-memory rows;
 *  5. screenshots each (`<out>-<list>.png`).
 *
 * The runtime config files are restored byte for byte and the seeds deleted at the
 * end (also on failure). Refuses main.
 *
 * Manual only — nothing runs this automatically.
 *   ./singularity run plugins/conversations/plugins/conversations-view/plugins/data-view/e2e/sidequest-filter.ts [--out /tmp/sidequest-filter] [--headed]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { configDir } from "@plugins/config_v2/data-dirs";
import type { Page } from "playwright";
import {
  arg,
  boot,
  onBeforeFinish,
  openDeployDb,
  pathUrl,
  report,
  snap,
  targetNamespace,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { tapSharedSocket } from "@plugins/primitives/plugins/networking/e2e";
import {
  frameOf,
  seedConversations,
  sweepSeeded,
} from "@plugins/conversations/plugins/all-conversations/e2e";

const OUT = arg("out") ?? "/tmp/sidequest-filter";
/**
 * The deploy's RUNTIME config document (config_v2's user layer, which the
 * server reads and watches, under the namespace's subtree): the user's
 * override when there is one — it wins — else the propagated origin.
 */
function runtimeConfig(rel: string): string {
  const dir = resolve(configDir.file(targetNamespace()), rel);
  const override = `${dir}.jsonc`;
  return existsSync(override) ? override : `${dir}.origin.jsonc`;
}
const SIDEBAR_CONFIG = runtimeConfig(
  "conversations/conversations-view/data-view/conversations-sidebar",
);
const ALL_CONFIG = runtimeConfig(
  "conversations/all-conversations/all-conversations",
);
/** The exposed column's wire name — what a server-filtered list's frames carry. */
const TRACK_COLUMN = "tasks_ext_track.track";

const db = openDeployDb();
const originals = new Map<string, string>();

let cleaned = false;
async function cleanup(): Promise<void> {
  if (cleaned) return;
  cleaned = true;
  for (const [path, text] of originals) writeFileSync(path, text);
  await sweepSeeded(db);
  await db.close();
}
onBeforeFinish(cleanup);

/** A view row filtered to the sidequest track and grouped by it. */
function sidequestView(id: string, source: string | null, type: string) {
  return {
    id,
    name: `E2E sidequest ${id}`,
    ...(source === null ? {} : { source }),
    view: {
      type,
      groupBy: "track",
      filter: {
        kind: "group",
        id: `${id}-filter`,
        conjunction: "and",
        children: [
          {
            kind: "rule",
            id: `${id}-track`,
            fieldId: "track",
            operatorId: "is-any-of",
            value: ["sidequest"],
          },
        ],
      },
    },
  };
}

/** Prepend `rows` to a config file's `views` (its original bytes kept for the restore). */
function addViews(path: string, rows: readonly object[]): void {
  const text = readFileSync(path, "utf8");
  if (!originals.has(path)) originals.set(path, text);
  const anchor = '"views": [';
  const at = text.indexOf(anchor);
  if (at === -1) throw new Error(`${path}: no \`${anchor}\` to add views to`);
  const end = at + anchor.length;
  const inserted = rows.map((r) => `\n    ${JSON.stringify(r)},`).join("");
  writeFileSync(path, text.slice(0, end) + inserted + text.slice(end));
}

/**
 * Which of the seeded task ids a list's text names — a row shows its
 * conversation's title or its task's, per the list and the title setting,
 * and each carries the task id. `table` matches the All-conversations table's
 * Worktree cell (`/tmp/<taskId>`) only: the sidebar beside it lists the
 * unfiltered Queue, which shows no worktree.
 */
async function shownOf(
  page: Page,
  taskIds: string[],
  scope: "page" | "table",
): Promise<string[]> {
  const text = await page.locator("body").innerText();
  return taskIds
    .filter((id) => text.includes(scope === "table" ? `/tmp/${id}` : id))
    .sort();
}

/** The group headers on screen: each collapsible trigger's text, whitespace folded. */
async function headersOf(page: Page): Promise<string[]> {
  return (await page.locator("[aria-expanded]").allInnerTexts()).map((t) =>
    t.replace(/\s+/g, " ").trim(),
  );
}

const QUEUE_VIEW = "e2e-sidequest-queue";
const HISTORY_VIEW = "e2e-sidequest-history";
const ALL_VIEW = "e2e-sidequest-all";

try {
  await sweepSeeded(db);
  const side = await seedConversations(db);
  const main = await seedConversations(db);
  await db.query(
    "INSERT INTO tasks_ext_track (parent_id, track) VALUES ($1, 'sidequest')",
    [side.taskId],
  );
  addViews(SIDEBAR_CONFIG, [
    sidequestView(QUEUE_VIEW, "queue", "list"),
    sidequestView(HISTORY_VIEW, "history", "list"),
  ]);
  addViews(ALL_CONFIG, [sidequestView(ALL_VIEW, null, "table")]);

  await withBrowser(async (h) => {
    const r = report("conversation lists — filter and group by Track");
    const lists = [
      {
        name: "queue",
        storageKey: "conversations-sidebar",
        view: QUEUE_VIEW,
        path: "/agents",
        live: null,
      },
      {
        name: "history",
        storageKey: "conversations-sidebar",
        view: HISTORY_VIEW,
        path: "/agents",
        live: "conversations.history",
      },
      {
        name: "all-conversations",
        storageKey: "all-conversations",
        view: ALL_VIEW,
        path: "/agents/all-conversations",
        live: "conversations.all",
      },
    ] as const;
    for (const list of lists) {
      const { page } = await h.session({
        viewport: { width: 1400, height: 1000 },
      });
      const frames: string[] = [];
      (await tapSharedSocket(page)).onFrame((f) => frames.push(f.data));
      // The view to open: the DataView's per-device active instance.
      await page.addInitScript(
        ([key, view]) => localStorage.setItem(`${key}:active-view`, view!),
        [list.storageKey, list.view],
      );
      await boot(page, pathUrl(list.path), { settleMs: 1500 });
      const shown = await waitFor(
        () =>
          shownOf(
            page,
            [side.taskId, main.taskId],
            list.live === "conversations.all" ? "table" : "page",
          ),
        (s) => s.length === 1 && s[0] === side.taskId,
        { timeoutMs: 60_000 },
      );
      r.eq(
        `${list.name}: the sidequest conversation is listed, the main one is not`,
        shown.value,
        [side.taskId],
      );
      const headers = await headersOf(page);
      console.log(`${list.name} group headers:`, headers);
      r.ok(
        `${list.name}: grouped by Track — a Sidequest section, no Main one`,
        headers.some((t) => /^Sidequest\b/.test(t)) &&
          !headers.some((t) => /^Main\b/.test(t)),
        headers.join(" | "),
      );
      if (list.live !== null) {
        const LIST_FRAME = frameOf(list.live);
        r.ok(
          `${list.name}: the server filters and groups by the exposed column`,
          frames.some((f) => LIST_FRAME.test(f) && f.includes(TRACK_COLUMN)),
          `${frames.filter((f) => LIST_FRAME.test(f)).length} frames of ${list.live}`,
        );
      }
      await snap(page, OUT, list.name);
      await page.close();
    }
    await r.finish();
  });
} finally {
  await cleanup();
}
