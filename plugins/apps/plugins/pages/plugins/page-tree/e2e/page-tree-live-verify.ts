/**
 * The page tree is ROUTED end to end
 * (`research/2026-10-08-global-page-tree-and-agents-routed.md` §7): with the
 * Pages sidebar open, each write reaches it as the scoped delta the plan
 * prices, checked on the socket's frames — never by the DOM alone.
 *
 *  1. **Typing** in a text block of a page — the ~1 s `data.text` projection —
 *     produces NO `pages.tree` frame (no page row changed).
 *  2. **Dragging a to-do that holds a sub-page** past two sibling sub-pages
 *     produces ONE `pages.tree` upsert, of that sub-page (the reconcile
 *     re-mints its `docRank` and keeps the other two), and the sidebar order
 *     follows (the client sorts by `docRank`).
 *  3. **Renaming** a page produces one upsert, of that page, carrying the new
 *     title.
 *  4. **Adding a `[[page:…]]` link** produces one `page-links.sources` upsert,
 *     of the TARGET page, with the source in `linkedFrom`.
 *
 * The writes go through the app's own endpoints (`agentFetch`), never straight
 * into the database: `doc_rank` is maintained by the server's structural-write
 * chokepoint, and the link edge by its reindex. The drag is the sidebar's own
 * `POST /api/blocks/:id/move` rather than a synthesized pointer drag (dnd-kit's
 * `PointerSensor` does not reliably activate under Playwright — see
 * `grouped-reorder.ts`). Typing is real keystrokes in the editor.
 *
 * The seeded pages are agent-origin (they land in Scratch) and are trashed at
 * the end, also on failure.
 *
 * Manual only. Run after `./equin build`:
 *   ./equin run plugins/apps/plugins/pages/plugins/page-tree/e2e/page-tree-live-verify.ts [--headed] [--out /tmp/page-tree-live]
 */
import { randomBytes } from "node:crypto";
import type { Locator, Page } from "playwright";
import { pagesTree } from "@plugins/page/plugins/editor/core";
import { pageLinkSources } from "@plugins/page/plugins/links/core";
import {
  agentFetch,
  arg,
  boot,
  ELEMENT_TIMEOUT_MS,
  onBeforeFinish,
  openDeployDb,
  pathUrl,
  report,
  snap,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { tapSharedSocket } from "@plugins/primitives/plugins/networking/e2e";

const OUT = arg("out") ?? "/tmp/page-tree-live";
const TREE_KEY = pagesTree.key;
const LINKS_KEY = pageLinkSources.key;
/**
 * How long a write that must produce NO frame is watched. Absence cannot be
 * polled: this covers the projection's ~1 s debounce, the doc flush and the
 * runtime's flush with margin.
 */
const QUIET_MS = 4_000;

const db = openDeployDb();
const tag = randomBytes(3).toString("hex");
const title = (name: string) => `e2e-tree-live ${tag} ${name}`;

interface Block {
  id: string;
  data: Record<string, unknown>;
}

async function api<T>(method: string, path: string, body?: unknown) {
  const res = await agentFetch(path, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

const createBlock = (
  parentId: string | null,
  type: string,
  data: Record<string, unknown>,
) => api<Block>("POST", "/api/blocks", { parentId, type, data });
// Seeded WITH an icon: auto-icon picks one for an icon-less titled page ~10 s
// after its edits settle (`setPageIcon(…, { onlyIfUnset })`), and that write is
// a real page-row upsert that would land inside the steps' frame windows.
const createPage = (parentId: string | null, name: string) =>
  createBlock(parentId, "page", { title: title(name), icon: "📄" });
const text = (s: string) => ({ text: [{ text: s }] });

let rootId: string | null = null;
let cleaned = false;
async function cleanup(): Promise<void> {
  if (cleaned) return;
  cleaned = true;
  // One trash of the root takes its whole subtree (sub-pages included).
  if (rootId !== null) await api("DELETE", `/api/blocks/${rootId}`);
  await db.close();
}
onBeforeFinish(cleanup);

interface Frame {
  kind?: string;
  key?: string;
  upserts?: [string, unknown][];
  deletes?: string[];
}

/**
 * Every live frame the page receives, parsed, in order. Through the shared
 * socket's tap: the socket lives in a SharedWorker, out of `page.on("websocket")`'s
 * reach. Call before the page's first navigation.
 */
async function recordFrames(page: Page): Promise<Frame[]> {
  const frames: Frame[] = [];
  const tap = await tapSharedSocket(page);
  tap.onFrame((f) => {
    frames.push(JSON.parse(f.data) as Frame);
  });
  return frames;
}

/** The frames since `from` that CHANGED `key`'s value (a push), not reads or acks. */
const pushesOf = (frames: Frame[], key: string, from: number) =>
  frames
    .slice(from)
    .filter(
      (f) => f.key === key && (f.kind === "delta" || f.kind === "update"),
    );

/** Every upsert those pushes carry, as `[id, row]`. */
const upsertsOf = (frames: Frame[], key: string, from: number) =>
  pushesOf(frames, key, from).flatMap((f) => f.upserts ?? []);

/** The tree row (not a page-link, not the detail header) labelled exactly `name`. */
const row = (page: Page, name: string): Locator =>
  page
    .locator(".group\\/tree-row")
    .filter({ has: page.getByText(title(name), { exact: true }) })
    .first();

const r = report("pages.tree / page-links.sources are routed end to end");

await withBrowser(async (h) => {
  // The seed: root R holding a to-do whose child is sub-page S1, then sub-pages
  // S2 and S3 — so R's sidebar group reads S1, S2, S3 in document order.
  const root = await createPage(null, "R");
  rootId = root.id;
  const todo = await createBlock(root.id, "to-do", {
    ...text("outer to-do"),
    checked: false,
  });
  const s1 = await createPage(todo.id, "S1");
  const s2 = await createPage(root.id, "S2");
  const s3 = await createPage(root.id, "S3");
  const para = await createBlock(root.id, "text", text("typing here"));
  r.note(`seeded R=${root.id} S1=${s1.id} S2=${s2.id} S3=${s3.id}`);

  const { page } = await h.session();
  const frames = await recordFrames(page);
  await boot(page, pathUrl(`/pages/page/${root.id}`), { settleMs: 1500 });

  // The sidebar subscribed the set (its sub-ack carries the seeded root).
  const subscribed = await waitFor(
    async () =>
      frames.some((f) => f.key === TREE_KEY && f.kind === "sub-ack") &&
      frames.some((f) => f.key === LINKS_KEY && f.kind === "sub-ack"),
    (ok) => ok,
  );
  r.ok(
    `the page subscribed ${TREE_KEY} and ${LINKS_KEY}`,
    subscribed.ok,
    `keys seen: ${[...new Set(frames.map((f) => `${f.key}:${f.kind}`))].join(", ")}`,
  );

  // Open R's group in the sidebar, so the order check below reads its rows.
  const rootRow = row(page, "R");
  await rootRow.waitFor({ state: "visible", timeout: ELEMENT_TIMEOUT_MS });
  await rootRow.hover();
  const expand = rootRow.getByRole("button", { name: "Expand", exact: true });
  await expand.click({ force: true });
  await row(page, "S3").waitFor({
    state: "visible",
    timeout: ELEMENT_TIMEOUT_MS,
  });
  await snap(page, OUT, "0-seeded");

  // 1. Typing: real keystrokes in R's paragraph; wait until the projection
  //    lands in the row, then watch the socket for the rest of the window.
  {
    const at = frames.length;
    const editable = page.locator(
      `[data-block-id="${para.id}"] [contenteditable="true"]`,
    );
    await editable.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" and more", { delay: 30 });
    const projected = await waitFor(
      async () =>
        (
          await db.query<{ text: string }>(
            "SELECT data->'text'->0->>'text' AS text FROM page_blocks WHERE id = $1",
            [para.id],
          )
        )[0]?.text,
      (t) => t === "typing here and more",
    );
    r.ok(
      "the typed text reached the row's data.text projection",
      projected.ok,
      JSON.stringify(projected.value),
    );
    await page.waitForTimeout(QUIET_MS);
    r.eq(
      `typing produced no ${TREE_KEY} frame`,
      pushesOf(frames, TREE_KEY, at).length,
      0,
    );
  }

  // 2. The drag: the to-do (holding S1) moves after S3, so R's group reads
  //    S2, S3, S1 — one sub-page re-minted, the other two kept.
  {
    const at = frames.length;
    await api("POST", `/api/blocks/${todo.id}/move`, {
      parentId: root.id,
      targetId: s3.id,
      zone: "after",
    });
    const moved = await waitFor(
      async () => upsertsOf(frames, TREE_KEY, at),
      (ups) => ups.length > 0,
    );
    r.ok(`the drag reached the page as a ${TREE_KEY} upsert`, moved.ok);
    await page.waitForTimeout(QUIET_MS);
    r.eq(
      `the drag produced one ${TREE_KEY} upsert, of the dragged sub-page`,
      upsertsOf(frames, TREE_KEY, at).map(([id]) => id),
      [s1.id],
    );
    const order = await waitFor(
      async () =>
        Promise.all(
          ["S1", "S2", "S3"].map(
            async (n) => (await row(page, n).boundingBox())?.y ?? -1,
          ),
        ),
      ([y1, y2, y3]) => y2! >= 0 && y2! < y3! && y3! < y1!,
    );
    r.ok(
      "the sidebar reads S2, S3, S1",
      order.ok,
      `row y (S1, S2, S3): ${JSON.stringify(order.value)}`,
    );
    await snap(page, OUT, "2-dragged");
  }

  // 3. Rename S2: one upsert, of S2, carrying the new title.
  {
    const at = frames.length;
    const renamed = title("S2 renamed");
    await api("PATCH", `/api/blocks/${s2.id}`, {
      data: { ...s2.data, title: renamed },
    });
    await waitFor(
      async () => upsertsOf(frames, TREE_KEY, at),
      (ups) => ups.length > 0,
    );
    await page.waitForTimeout(QUIET_MS);
    const ups = upsertsOf(frames, TREE_KEY, at);
    r.eq(
      `the rename produced one ${TREE_KEY} upsert, of the renamed page`,
      ups.map(([id]) => id),
      [s2.id],
    );
    r.eq(
      "…carrying the new title",
      (ups[0]?.[1] as { data?: { title?: string } } | undefined)?.data?.title,
      renamed,
    );
  }

  // 4. A `[[page:S3]]` link written into R: one `page-links.sources` upsert,
  //    of S3, linked from R — and no `pages.tree` frame (a content block).
  {
    const at = frames.length;
    await createBlock(root.id, "text", text(`see [[page:${s3.id}]]`));
    await waitFor(
      async () => upsertsOf(frames, LINKS_KEY, at),
      (ups) => ups.length > 0,
    );
    await page.waitForTimeout(QUIET_MS);
    const ups = upsertsOf(frames, LINKS_KEY, at);
    r.eq(
      `the link produced one ${LINKS_KEY} upsert, of the target page`,
      ups.map(([id]) => id),
      [s3.id],
    );
    r.eq(
      "…with the source page in linkedFrom",
      (ups[0]?.[1] as { linkedFrom?: string[] } | undefined)?.linkedFrom,
      [root.id],
    );
    r.eq(
      `the link's content block produced no ${TREE_KEY} frame`,
      pushesOf(frames, TREE_KEY, at).length,
      0,
    );
  }
});

await r.finish();
