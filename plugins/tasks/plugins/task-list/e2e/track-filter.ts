/**
 * The task list filters by TRACK and groups by CATEGORY — two fields the
 * task extensions EXPOSE (fields declared once, phase 2:
 * research/2026-10-13-global-fields-declared-once-phase2.md), named by no
 * list code: `taskRows` is declared `from: tasksEntityRef`, so every exposed
 * task field folds into its rows.
 *
 *  1. seeds two tasks: one on the sidequest track (a `tasks_ext_track` row)
 *     filed under the `agents` category (a `tasks_ext_category` row), one on
 *     main (no row) under the same category;
 *  2. adds a view to the deploy's runtime config of the task list, filtered
 *     `Track is any of Sidequest` and grouped by Category, then opens it (its
 *     `active-view` key);
 *  3. the sidequest task is listed, the main one is not, and the seeded task
 *     sits under an "Agents" section — the category registry's label, read
 *     live (`useOptions`), never the raw id;
 *  4. screenshots it (`<out>-tasks.png`).
 *
 * The runtime config file is restored byte for byte and the seeds deleted at
 * the end (also on failure). Refuses main.
 *
 * Manual only — nothing runs this automatically.
 *   ./singularity run plugins/tasks/plugins/task-list/e2e/track-filter.ts [--out /tmp/track-filter] [--headed]
 */
import { randomBytes } from "node:crypto";
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

const OUT = arg("out") ?? "/tmp/track-filter";
/** Every seeded id starts with this, so a crashed run's leftovers are swept by prefix. */
const SEED_PREFIX = "e2e-tracklist-";
/** A registered category (conversations/agents' `TaskCategory`) and its label. */
const CATEGORY = { id: "agents", label: "Agents" };
const STORAGE_KEY = "tasks-list";
const VIEW = "e2e-track-filter";

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
const LIST_CONFIG = runtimeConfig("tasks/task-list/tasks-list");

const db = openDeployDb();
let original: string | null = null;

let cleaned = false;
async function cleanup(): Promise<void> {
  if (cleaned) return;
  cleaned = true;
  if (original !== null) writeFileSync(LIST_CONFIG, original);
  await db.query("DELETE FROM tasks WHERE id LIKE $1", [`${SEED_PREFIX}%`]);
  await db.close();
}
onBeforeFinish(cleanup);

/** Insert one reactor-inert task (a human title: no title upgrade runs), filed under `CATEGORY`. */
async function seedTask(): Promise<string> {
  const tag = randomBytes(3).toString("hex");
  const id = `${SEED_PREFIX}${tag}`;
  await db.query(
    `INSERT INTO tasks (id, title, title_auto, rank) VALUES ($1, $2, false, $3)`,
    [id, `${id} task`, `zz${tag}`],
  );
  await db.query(
    "INSERT INTO tasks_ext_category (parent_id, category) VALUES ($1, $2)",
    [id, CATEGORY.id],
  );
  return id;
}

/** The view: a list filtered to the sidequest track, grouped by category. */
const view = {
  id: VIEW,
  name: "E2E track filter",
  view: {
    type: "list",
    groupBy: "category",
    filter: {
      kind: "group",
      id: `${VIEW}-filter`,
      conjunction: "and",
      children: [
        {
          kind: "rule",
          id: `${VIEW}-track`,
          fieldId: "track",
          operatorId: "is-any-of",
          value: ["sidequest"],
        },
      ],
    },
  },
};

/** Prepend the view to the config's `views` (its original bytes kept for the restore). */
function addView(): void {
  const text = readFileSync(LIST_CONFIG, "utf8");
  original = text;
  const anchor = '"views": [';
  const at = text.indexOf(anchor);
  if (at === -1) {
    throw new Error(`${LIST_CONFIG}: no \`${anchor}\` to add a view to`);
  }
  const end = at + anchor.length;
  writeFileSync(
    LIST_CONFIG,
    `${text.slice(0, end)}\n    ${JSON.stringify(view)},${text.slice(end)}`,
  );
}

/** Which of the seeded task ids the page's text names (each row shows its title). */
async function shownOf(page: Page, ids: string[]): Promise<string[]> {
  const text = await page.locator("body").innerText();
  return ids.filter((id) => text.includes(id)).sort();
}

/** The group headers on screen: each collapsible trigger's text, whitespace folded. */
async function headersOf(page: Page): Promise<string[]> {
  return (await page.locator("[aria-expanded]").allInnerTexts()).map((t) =>
    t.replace(/\s+/g, " ").trim(),
  );
}

try {
  await db.query("DELETE FROM tasks WHERE id LIKE $1", [`${SEED_PREFIX}%`]);
  const side = await seedTask();
  const main = await seedTask();
  await db.query(
    "INSERT INTO tasks_ext_track (parent_id, track) VALUES ($1, 'sidequest')",
    [side],
  );
  addView();

  await withBrowser(async (h) => {
    const r = report("task list — filter by Track, group by Category");
    const { page } = await h.session({
      viewport: { width: 1400, height: 1000 },
    });
    // The view to open: the DataView's per-device active instance.
    await page.addInitScript(
      ([key, id]) => localStorage.setItem(`${key}:active-view`, id!),
      [STORAGE_KEY, VIEW],
    );
    await boot(page, pathUrl("/agents/tasks"), { settleMs: 1500 });
    const shown = await waitFor(
      () => shownOf(page, [side, main]),
      (s) => s.length === 1 && s[0] === side,
      { timeoutMs: 60_000 },
    );
    r.eq("the sidequest task is listed, the main one is not", shown.value, [
      side,
    ]);
    const headers = await headersOf(page);
    console.log("group headers:", headers);
    r.ok(
      `grouped by Category — an "${CATEGORY.label}" section (the registry's label, not the id)`,
      headers.some((t) => t.startsWith(CATEGORY.label)) &&
        !headers.some((t) => t.startsWith(CATEGORY.id)),
      headers.join(" | "),
    );
    await snap(page, OUT, "tasks");
    await page.close();
    await r.finish();
  });
} finally {
  await cleanup();
}
