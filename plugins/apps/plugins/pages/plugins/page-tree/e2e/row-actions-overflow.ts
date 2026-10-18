/**
 * Verifies the Pages sidebar row's authored action split: ONE `⋯` holding the
 * overflow bucket, not a cluster of icons and not two competing menus.
 *
 * A blind `screenshot.ts --click "More"` cannot do this: the action cluster is
 * `opacity-0 pointer-events-none` until the row is hovered, so the click lands
 * on the row beneath and navigates instead. The hover IS the flow under test, so
 * it has to be a script.
 *
 *   ./singularity run plugins/apps/plugins/pages/plugins/page-tree/e2e/row-actions-overflow.ts --headed
 */
import {
  arg,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { setEditMode } from "@plugins/reorder/plugins/edit-mode/e2e";

const OUT = arg("out") ?? "/tmp/pages-overflow";

/** The three actions the committed config puts inside the bucket. */
const BUCKETED = ["Delete page", "Upgrade to story", "Add page below"];

await withBrowser(async (h) => {
  const r = report("pages sidebar — row-action overflow bucket");
  const { page, captured } = await h.session();

  await page.goto(pathUrl("pages"), { waitUntil: "domcontentloaded" });

  // The sidebar tree row. Wait for a real row rather than a fixed timeout.
  const row = page.locator('[data-ui-owner^="TreeRowChrome"]').first();
  await row.waitFor({ state: "visible", timeout: 30_000 });
  await snap(page, OUT, "before");

  // Reveal the cluster the way a user does.
  await row.hover();

  const inlineButtons = row.locator("button[aria-label]");
  const labels = (
    await inlineButtons.evaluateAll((els) =>
      els.map((e) => e.getAttribute("aria-label") ?? ""),
    )
  ).filter(Boolean);
  r.note(`inline affordances on hover: ${JSON.stringify(labels)}`);

  // Exactly one "More" trigger — the whole point of unifying with `rowMenu`.
  const moreCount = labels.filter((l) => l === "More").length;
  r.eq("exactly one ⋯ trigger on the row", moreCount, 1);

  // The bucketed actions must NOT be inline.
  for (const name of BUCKETED) {
    r.ok(
      `"${name}" is not inline`,
      !labels.includes(name),
      `inline: ${labels.join(", ")}`,
    );
  }
  // Star stays inline (authored as the one high-frequency action).
  r.ok(
    "a star toggle stays inline",
    labels.some((l) => /favorit/i.test(l)),
    `inline: ${labels.join(", ")}`,
  );

  const more = row.getByRole("button", { name: "More", exact: true });

  // The `⋯` IS the anchor every menu launched from this row positions against,
  // so its own x is the invariant — the menu box below is downstream of it.
  // Captured here, while the row is hovered and the menu is still CLOSED: that
  // is the geometry the open menu must preserve.
  const triggerX = async () => {
    const b = await more.boundingBox();
    return b ? Math.round(b.x) : null;
  };
  const anchorClosed = await triggerX();
  r.ok("the ⋯ trigger is laid out while hovered", anchorClosed !== null);

  await more.click();

  const menu = page.getByRole("menu");
  await menu.waitFor({ state: "visible", timeout: 10_000 });
  await snap(page, OUT, "after");

  const items = (await menu.getByRole("menuitem").allTextContents()).map((t) =>
    t.trim(),
  );
  r.note(`menu rows: ${JSON.stringify(items)}`);

  // Labelled rows, not a strip of icon buttons — the presentation switch.
  for (const name of BUCKETED) {
    r.ok(
      `"${name}" is a labelled menu row`,
      items.some((t) => t.includes(name)),
      `got: ${items.join(" | ")}`,
    );
  }
  r.eq(
    "menu holds exactly the bucketed actions",
    items.length,
    BUCKETED.length,
  );

  // --- The open menu must not move when the pointer leaves the row -----------
  // The row's action cluster is the menu's ANCHOR, so anything that changes its
  // geometry off-hover drags the open menu sideways with it. The cluster used to
  // reveal by changing LAYOUT (`w-0` → `w-auto`), held open only by a CSS rule
  // naming base-ui's `data-popup-open` attribute — unverifiable by any type
  // system, and it had already rotted once (it named Radix's `data-[state=open]`,
  // which matches nothing here, and the menu jumped ~52px right). The cluster now
  // reveals with OPACITY behind a pinned mask, so it reserves no flow width and
  // its geometry cannot depend on hover at all. These assertions are what proves
  // that; they are the mechanism's only runtime guard.
  const boxOf = async () => {
    const b = await menu.boundingBox();
    return b ? { x: Math.round(b.x), y: Math.round(b.y) } : null;
  };
  const atOpen = await boxOf();
  await page.mouse.move(900, 620); // off the row, onto the menu's backdrop
  await page.waitForTimeout(400);
  const atRest = await boxOf();
  r.eq("open menu does not move when the row loses hover", atRest, atOpen);
  r.eq(
    "⋯ anchor is where it was before its menu opened",
    await triggerX(),
    anchorClosed,
  );

  // The typed popup-open signal is what keeps the cluster VISIBLE here — the row
  // lost hover, so without it the still-open menu would hang off an invisible
  // trigger. Position is now stable by construction; visibility is not, so it
  // needs its own assertion. Read as the first non-1 opacity up the ancestor
  // chain, since the fade lives on the cluster, not the button.
  const effectiveOpacity = await more.evaluate((el) => {
    for (
      let n: HTMLElement | null = el as HTMLElement;
      n;
      n = n.parentElement
    ) {
      const o = getComputedStyle(n).opacity;
      if (o !== "1") return Number(o);
    }
    return 1;
  });
  r.eq("⋯ stays visible while its own menu is open", effectiveOpacity, 1);

  await page.keyboard.press("Escape");

  // --- Favorites: the SAME authored bucket, in a flat `list` view -------------
  // `AddPageBelowAction` reads the tree row's controls, so it renders null here.
  // That is the normal non-tree case: the bucket must degrade to its remaining
  // members, not crash and not paint an empty menu.
  // The sidebar renders every view as a section (Favorites first), so there is
  // no switcher to click: wait for the Favorites header, then take the FIRST
  // "Todos" — the Favorites row, which sits above the Private tree's.
  await page
    .getByRole("button", { name: /^Favorites/ })
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
  const favLabel = page.getByText("Todos", { exact: true }).first();
  await favLabel.waitFor({ state: "visible", timeout: 10_000 });
  await favLabel.hover();

  const favMore = page.getByRole("button", { name: "More", exact: true });
  r.eq("Favorites row still has one ⋯", await favMore.count(), 1);
  await favMore.click();

  const favMenu = page.getByRole("menu");
  await favMenu.waitFor({ state: "visible", timeout: 10_000 });
  await snap(page, OUT, "favorites");
  const favItems = (await favMenu.getByRole("menuitem").allTextContents()).map(
    (t) => t.trim(),
  );
  r.note(`favorites menu rows: ${JSON.stringify(favItems)}`);

  r.ok(
    "bucket degrades — menu is not empty",
    favItems.length > 0,
    "an empty ⋯ menu is a dead affordance",
  );
  r.ok(
    "Add page below is absent outside a tree",
    !favItems.some((t) => t.includes("Add page below")),
    `got: ${favItems.join(" | ")}`,
  );

  await page.keyboard.press("Escape");

  // --- Edit mode: the bucket must not hide its members behind a menu ------
  // A closed dropdown would suppress drag and hide what is being authored, so
  // the container renders its inline form in edit mode instead.
  await page.locator('button[data-tooltip="Pages"]').click();

  await setEditMode(page, true);

  await page.locator('[data-ui-owner^="TreeRowChrome"]').first().hover();
  await snap(page, OUT, "edit-mode");
  r.ok(
    "entered edit mode",
    (await page.locator('[aria-roledescription="sortable"]').count()) > 0,
    "no sortables on the page",
  );

  const errors = [
    ...captured.pageErrors,
    ...captured.consoleErrors,
    ...captured.failedRequests,
  ];
  r.ok(
    "no page errors, console errors or failed requests",
    errors.length === 0,
    errors.join("\n"),
  );
  await r.finish();
});
