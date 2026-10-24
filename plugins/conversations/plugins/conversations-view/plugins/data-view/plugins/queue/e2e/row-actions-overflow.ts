/**
 * Verifies the conversation sidebar's authored action split: Pin is the only
 * inline icon on a queue row, everything else lives behind that row's single
 * `⋯`, and a row where NONE of the bucketed actions apply carries no `⋯` at all.
 *
 * The last one is the interesting case and is why this is a script, not a blind
 * screenshot: the queue's Done rows can use none of the five bucketed actions,
 * so a bucket that painted its trigger from its AUTHORED membership would give
 * every closed conversation a `⋯` opening an empty menu.
 *
 *   ./equin run plugins/conversations/plugins/conversations-view/plugins/data-view/plugins/queue/e2e/row-actions-overflow.ts --headed
 */
import {
  arg,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = arg("out") ?? "/tmp/queue-overflow";

/** The actions the committed config puts inside the bucket — never inline. */
const BUCKETED = [
  "Move to top",
  "Move down 5",
  "Move to bottom",
  "Add to queue",
  "Close conversation",
];

/** What a row may show inline. Pin has two faces; `⋯` is the bucket itself. */
const ALLOWED_INLINE = new Set(["Pin to top", "Unpin", "More"]);

interface RowShape {
  title: string;
  labels: string[];
}

await withBrowser(async (h) => {
  const r = report("conversations queue — row-action overflow bucket");
  const { page, captured } = await h.session();

  await page.goto(pathUrl("agents"), { waitUntil: "domcontentloaded" });
  const items = page.locator('[data-ui-owner^="ConversationItem"]');
  await items.first().waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(1000); // let the live queue settle before sampling
  await snap(page, OUT, "sidebar");

  // Read every row at once. The cluster is a sibling of the item inside the Row,
  // so walk up to the row box rather than querying within the item. `opacity-0`
  // still leaves the buttons in the DOM, so this needs no hover.
  const rows: RowShape[] = await items.evaluateAll((els) =>
    els.map((el) => {
      const row = (el as HTMLElement).closest(
        '[data-ui-owner^="Row@"]',
      ) as HTMLElement | null;
      return {
        title: (el as HTMLElement).innerText.split("\n")[0]?.slice(0, 40) ?? "",
        labels: row
          ? Array.from(row.querySelectorAll("button[aria-label]"))
              .map((b) => b.getAttribute("aria-label") ?? "")
              .filter((l) => l.length > 0 && l.length < 40)
          : [],
      };
    }),
  );
  r.ok("the sidebar has queue rows", rows.length > 0);

  const shapes = new Map<string, number>();
  for (const row of rows) {
    const key = JSON.stringify(row.labels);
    shapes.set(key, (shapes.get(key) ?? 0) + 1);
  }
  for (const [shape, n] of shapes) r.note(`${n} × ${shape}`);

  // 1. Nothing but Pin and the bucket is inline.
  const strays = [
    ...new Set(
      rows.flatMap((row) => row.labels.filter((l) => !ALLOWED_INLINE.has(l))),
    ),
  ];
  r.ok(
    "only Pin and the ⋯ are inline",
    strays.length === 0,
    `also inline: ${strays.join(", ")}`,
  );
  for (const name of BUCKETED) {
    r.ok(
      `"${name}" is not inline on any row`,
      !rows.some((row) => row.labels.includes(name)),
    );
  }

  // 2. No row carries a ⋯ with nothing behind it. Sampled — opening all 60+
  //    menus buys nothing, and the shape is per-section, not per-row.
  const withMore = rows.filter((row) => row.labels.includes("More"));
  r.ok("some rows have a ⋯", withMore.length > 0);

  // Re-derived live rather than indexed off the snapshot above: the queue is a
  // live list and rows reorder under the cursor between the two.
  const rowsWithMore = page
    .locator('[data-ui-owner^="Row@"]')
    .filter({ has: page.getByRole("button", { name: "More", exact: true }) });

  const sample = Math.min(await rowsWithMore.count(), 3);
  for (let i = 0; i < sample; i++) {
    const row = rowsWithMore.nth(i);
    const title = (await row.innerText()).split("\n")[0]?.slice(0, 40) ?? "";
    const more = row.getByRole("button", { name: "More", exact: true });
    // `dispatchEvent`, not `click`: the cluster is `pointer-events-none` until
    // its row is hovered, and a live re-render can drop that hover mid-gesture.
    // The reveal is the row-actions primitive's contract, verified in ITS e2e —
    // what is under test here is what the ⋯ holds.
    await more.dispatchEvent("click");
    const menu = page.getByRole("menu");
    await menu.waitFor({ state: "visible", timeout: 10_000 });
    if (i === 0) await snap(page, OUT, "menu");
    const entries = (await menu.getByRole("menuitem").allTextContents()).map(
      (t) => t.trim(),
    );
    r.note(`"${title}" ⋯ → ${JSON.stringify(entries)}`);
    r.ok(
      `⋯ on "${title}" is not a dead affordance`,
      entries.length > 0,
      "a trigger opening an empty menu",
    );
    r.ok(
      "its rows are labelled, drawn from the bucket",
      entries.every((t) => BUCKETED.some((name) => t.includes(name))),
      `got: ${entries.join(" | ")}`,
    );
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "hidden", timeout: 10_000 });
  }

  // 3. The rows with NO ⋯ are the ones where nothing applies — they must not
  //    carry a Pin either, since Pin and the whole bucket bow out together only
  //    on a closed conversation.
  const bare = rows.filter((row) => !row.labels.includes("More"));
  r.note(`${bare.length} rows carry no ⋯ at all (nothing applies to them)`);
  r.ok(
    "a row with no ⋯ shows no other action either",
    bare.every((row) => row.labels.length === 0),
    `got: ${bare.map((row) => JSON.stringify(row.labels)).join(" ")}`,
  );

  const errors = [...captured.pageErrors, ...captured.consoleErrors];
  r.ok("no page or console errors", errors.length === 0, errors.join("\n"));
  await r.finish();
});
