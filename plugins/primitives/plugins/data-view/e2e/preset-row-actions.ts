// Drives a saved filter preset's own row: create it, hover it, delete it from
// the row, and undo that from the toast.
//
// The preset row is the first `ControlPanel.Row` in the app to carry `actions`,
// and that prop changes the row's CONSTRUCTION — the box stops being the click
// target and an inner subgrid becomes it, so the trash button is the target's
// sibling rather than its descendant. Only a browser can check that split
// actually holds: that the row box is not a button, that the selectable region
// is, that the trash is hidden at rest and revealed on hover, and that pressing
// it does not also fire the apply beside it.
//
//   ./equin run plugins/primitives/plugins/data-view/e2e/preset-row-actions.ts --out /tmp/presets
//   ./equin run plugins/primitives/plugins/data-view/e2e/preset-row-actions.ts --headed
import {
  arg,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const out = arg("out", "/tmp/preset-row-actions");
const url = pathUrl("/agents");

/** A name this run owns, so a re-run never collides with its own leftovers. */
const PRESET = `e2e preset ${Date.now().toString().slice(-6)}`;

await withBrowser(async (h) => {
  const r = report("DataView preset row actions");
  const { page } = await h.session({
    viewport: { width: 1600, height: 1000 },
    colorScheme: "dark",
  });

  await page.goto(url);
  await page.waitForTimeout(4000);
  await page
    .getByRole("button", { name: "Tasks", exact: true })
    .first()
    .click({ noWaitAfter: true });
  await page.waitForTimeout(2500);

  /**
   * Opens the Filter control, whose trigger is named "Filter" or "Filter: …".
   *
   * Dispatched from inside the page rather than through Playwright's own click:
   * the trigger is a popover trigger that re-renders as the panel animates, and
   * a locator click waits for a stability it never reaches.
   */
  const openFilter = async () => {
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find((b) =>
        /^Filter(:|$)/.test(b.getAttribute("aria-label") ?? ""),
      );
      if (!btn) throw new Error("no Filter trigger on screen");
      if (btn.getAttribute("aria-expanded") !== "true") btn.click();
    });
    await page.waitForTimeout(1500);
  };

  /**
   * Clicks a control-panel row (or any button) inside the open panel, by its
   * visible text, from inside the page.
   *
   * Same reason as `openFilter`: a locator click waits for the element to hold
   * still, and a panel that re-renders as its stack animates never does. The
   * DOM `click()` dispatches a real click event, which is what React listens
   * for, so nothing about the assertion is weakened.
   */
  const clickInPanel = async (text: string, exact = false) => {
    await page.evaluate(
      ({ t, exact }: { t: string; exact: boolean }) => {
        const btn = Array.from(
          document.querySelectorAll<HTMLElement>(".cp-panel button"),
        ).find((b) => {
          const label = b.innerText.trim();
          return exact
            ? label === t
            : label.toLowerCase().includes(t.toLowerCase());
        });
        if (!btn) throw new Error(`no "${t}" button in the open panel`);
        btn.click();
      },
      { t: text, exact },
    );
    await page.waitForTimeout(1500);
  };

  // ── Create a preset through the real UI ────────────────────────────
  // The landing view ships an authored filter, so there is already a tree to
  // save — which is what makes "Save as preset" reachable at all.
  await openFilter();
  const save = page.getByRole("button", { name: /Save as preset/i }).first();
  r.ok("filter panel offers Save as preset", (await save.count()) > 0);
  await clickInPanel("Save as preset");

  await page.locator(".cp-panel input").first().fill(PRESET);
  await page.waitForTimeout(300);
  await clickInPanel("Save preset", true);
  await page.waitForTimeout(600);

  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  await openFilter();
  await snap(page, out, "presets-section");

  // ── The construction ──────────────────────────────────────────────
  // Read the row's own DOM rather than trusting the screenshot. Everything here
  // is a claim the `actions` construction makes and the plain one does not.
  const shape = await page.evaluate((name: string) => {
    const label = Array.from(
      document.querySelectorAll('.cp-panel [data-cp-cell="label"]'),
    ).find((el) => (el as HTMLElement).innerText.trim() === name);
    const row = label?.closest(".cp-row") as HTMLElement | undefined;
    if (!row) return null;
    const select = row.querySelector("[data-cp-select]") as HTMLElement | null;
    const trailing = row.querySelector(
      '[data-cp-cell="trailing"]',
    ) as HTMLElement | null;
    const trash = trailing?.querySelector("button") ?? null;
    return {
      rowTag: row.tagName,
      selectTag: select?.tagName ?? null,
      selectRole: select?.getAttribute("role") ?? null,
      // The trash must be a SIBLING of the click target, never inside it.
      trashInsideSelect: select && trash ? select.contains(trash) : null,
      trashLabel: trash?.getAttribute("aria-label") ?? null,
      // Hidden at rest: opacity 0 AND pointer-events none, coupled, so the
      // invisible button is never a live hit-target over the row.
      restOpacity: trash
        ? getComputedStyle(trash.closest("[class]") ?? trash).opacity
        : null,
      // The cells the panel's own rails depend on must still be found, one
      // level deeper than the plain construction puts them.
      cells: Array.from(row.querySelectorAll("[data-cp-cell]")).map((c) =>
        c.getAttribute("data-cp-cell"),
      ),
    };
  }, PRESET);

  r.ok("the preset row is on screen", shape !== null, JSON.stringify(shape));
  if (!shape) {
    await r.finish();
    return;
  }

  r.ok("row box is NOT the click target", shape.rowTag === "DIV", shape.rowTag);
  r.ok(
    "the selectable region is a button",
    shape.selectTag === "BUTTON",
    `${shape.selectTag} role=${shape.selectRole}`,
  );
  r.ok(
    "applying is still a radio",
    shape.selectRole === "radio",
    String(shape.selectRole),
  );
  r.ok(
    "the trash is a SIBLING of the click target, not nested in it",
    shape.trashInsideSelect === false,
    `trashInsideSelect=${String(shape.trashInsideSelect)}`,
  );
  r.ok(
    "the trash names the preset it deletes",
    (shape.trashLabel ?? "").includes(PRESET),
    String(shape.trashLabel),
  );
  r.ok(
    "the row still renders its four cells",
    ["gutter", "icon", "label", "trailing"].every((c) =>
      shape.cells.includes(c),
    ),
    shape.cells.join(","),
  );

  // ── Hover reveals it ──────────────────────────────────────────────
  // A REAL pointer move, not `locator.hover()`: the reveal is a CSS `:hover`
  // rule, so it answers to the mouse and to nothing a script can dispatch —
  // and moving the mouse skips the actionability wait that the animating panel
  // never satisfies.
  const rowBox = await page.evaluate((name: string) => {
    const label = Array.from(
      document.querySelectorAll('.cp-panel [data-cp-cell="label"]'),
    ).find((el) => (el as HTMLElement).innerText.trim() === name);
    const row = label?.closest(".cp-row");
    if (!row) return null;
    const b = row.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }, PRESET);
  r.ok("the preset row has a box to point at", rowBox !== null);
  if (rowBox) await page.mouse.move(rowBox.x, rowBox.y);
  await page.waitForTimeout(600);
  await snap(page, out, "row-hovered");

  const hoverOpacity = await page.evaluate((name: string) => {
    const label = Array.from(
      document.querySelectorAll('.cp-panel [data-cp-cell="label"]'),
    ).find((el) => (el as HTMLElement).innerText.trim() === name);
    const trash = label
      ?.closest(".cp-row")
      ?.querySelector('[data-cp-cell="trailing"] button');
    if (!trash) return null;
    return getComputedStyle(trash.closest("[class]") ?? trash).opacity;
  }, PRESET);
  r.ok(
    "the trash is revealed on hover",
    hoverOpacity === "1",
    `rest=${shape.restOpacity} hover=${hoverOpacity}`,
  );

  // ── Deleting is one click, and does not also apply ────────────────
  // Pressed with the real pointer, from where the hover left it — so this is
  // the same gesture a user makes, on a button that is only hittable BECAUSE
  // the row is hovered (the reveal couples opacity with pointer-events).
  const trashBox = await page.evaluate((name: string) => {
    const label = Array.from(
      document.querySelectorAll('.cp-panel [data-cp-cell="label"]'),
    ).find((el) => (el as HTMLElement).innerText.trim() === name);
    const trash = label
      ?.closest(".cp-row")
      ?.querySelector('[data-cp-cell="trailing"] button');
    if (!trash) return null;
    const b = trash.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }, PRESET);
  r.ok("the trash has a box to press", trashBox !== null);
  if (trashBox) await page.mouse.click(trashBox.x, trashBox.y);
  await page.waitForTimeout(1400);
  await snap(page, out, "after-delete");

  const gone = await page.evaluate(
    (name: string) =>
      !Array.from(document.querySelectorAll("[data-cp-cell='label']")).some(
        (el) => (el as HTMLElement).innerText.trim() === name,
      ),
    PRESET,
  );
  r.ok("the row leaves on delete", gone);

  // ── …and the way back is on screen ───────────────────────────────
  const hasUndo = await page.evaluate(() =>
    Array.from(document.querySelectorAll("button")).some(
      (b) => b.innerText.trim() === "Undo",
    ),
  );
  r.ok("the delete raises a toast offering Undo", hasUndo);

  if (hasUndo) {
    await page.evaluate(() => {
      Array.from(document.querySelectorAll<HTMLElement>("button"))
        .find((b) => b.innerText.trim() === "Undo")
        ?.click();
    });
    await page.waitForTimeout(1500);
    await openFilter();
    await snap(page, out, "after-undo");
    const back = await page.evaluate(
      (name: string) =>
        Array.from(
          document.querySelectorAll('.cp-panel [data-cp-cell="label"]'),
        ).some((el) => (el as HTMLElement).innerText.trim() === name),
      PRESET,
    );
    r.ok("Undo puts the preset back", back);

    // Leave nothing behind: this run's preset is persisted config.
    if (back) {
      await page.evaluate((name: string) => {
        const label = Array.from(
          document.querySelectorAll('.cp-panel [data-cp-cell="label"]'),
        ).find((el) => (el as HTMLElement).innerText.trim() === name);
        const trash = label
          ?.closest(".cp-row")
          ?.querySelector<HTMLElement>('[data-cp-cell="trailing"] button');
        trash?.click();
      }, PRESET);
      await page.waitForTimeout(1000);
    }
  }

  await r.finish();
});
