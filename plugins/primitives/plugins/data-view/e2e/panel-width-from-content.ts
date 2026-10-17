// Verifies that a control panel is as wide as its SHOWING page's content
// declares (control-panel's `cp-surface` + `data-cp-needs`), on the real Tasks
// DataView at /agents:
//
//   - the toolbar Filter popover opens builder-wide, empty or not;
//   - view settings opens menu-wide, and its Fold rows page — the filter
//     builder, pushed from a menu — widens to the builder width, before AND
//     after a rule is added, with nothing overflowing the panel (the original
//     bug: the fold editor's rule rows spilled out of a menu-wide panel);
//   - going back to the settings root returns to menu width.
//
//   ./singularity run plugins/primitives/plugins/data-view/e2e/panel-width-from-content.ts --out /tmp/pw [--view Recent] [--fold-field Updated] [--falsify]
import {
  arg,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const out = arg("out", "/tmp/panel-width-from-content");
// A FLAT view of the Tasks list: a nested table (the Tree view) has no fold.
const view = arg("view", "Recent");
// Falsify the overflow guard: strip every width need from the open fold page
// (so it collapses to menu width) and drop a RIGID 260px box into the rule's
// value cell — a stand-in for a future control that declares no width and
// cannot yield — and expect the guard to measure it (it files a
// `panel-overflow` report).
const falsify = process.argv.includes("--falsify");
// The fold rule's field: a DATE rule, the original bug's case (its value
// control was a rigid button that overlapped the remove button).
const foldField = arg("fold-field", "Updated");
const url = pathUrl("/agents");

await withBrowser(async (h) => {
  const r = report("Control-panel width from content");
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
  await page.getByRole("button", { name: view, exact: true }).first().click();
  await page.waitForTimeout(1500);

  // The surface width, the panel's overflow, the needs on the showing level,
  // and the two bucket tokens resolved to px by laying out a probe.
  const measure = () =>
    page.evaluate(() => {
      const surface = document.querySelector<HTMLElement>(".cp-surface");
      if (!surface) return null;
      const panel = surface.querySelector<HTMLElement>(".cp-panel")!;
      const token = (name: string) => {
        const probe = document.createElement("div");
        probe.style.cssText = `position:fixed;visibility:hidden;width:var(${name})`;
        surface.appendChild(probe);
        const w = probe.getBoundingClientRect().width;
        probe.remove();
        return Math.round(w);
      };
      return {
        width: Math.round(surface.getBoundingClientRect().width),
        // Past the panel's edge, or — a squeezed builder row — a control
        // spilling out of its (min-w-0) grid cell; a clipping cell is
        // truncating on purpose and does not count.
        overflow: Math.max(
          panel.scrollWidth - panel.clientWidth,
          ...[
            ...surface.querySelectorAll<HTMLElement>(
              "[data-cp-showing] [data-cp-cell]",
            ),
          ]
            .filter((c) => getComputedStyle(c).overflowX === "visible")
            .map((c) => c.scrollWidth - c.clientWidth),
        ),
        needs: [
          ...surface.querySelectorAll("[data-cp-showing] [data-cp-needs]"),
        ].map((el) => el.getAttribute("data-cp-needs")),
        // Which cells overflow, and what inside them reaches past the cell.
        cells: [
          ...surface.querySelectorAll<HTMLElement>(
            "[data-cp-showing] [data-cp-cell]",
          ),
        ]
          .filter(
            (c) =>
              getComputedStyle(c).overflowX === "visible" &&
              c.scrollWidth - c.clientWidth > 0.5,
          )
          .map((c) => {
            const right = c.getBoundingClientRect().right;
            const past = [...c.querySelectorAll<HTMLElement>("*")]
              .filter((el) => el.getBoundingClientRect().right > right + 0.5)
              .map(
                (el) =>
                  `${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 4).join(".")}(+${Math.round(el.getBoundingClientRect().right - right)})`,
              );
            return `${c.getAttribute("data-cp-cell")} ${c.clientWidth}/${c.scrollWidth}: ${past.slice(0, 4).join(" ")}`;
          }),
        menu: token("--popover-width-menu-max"),
        builder: token("--popover-width-builder"),
      };
    });
  const describe = (m: Awaited<ReturnType<typeof measure>>) =>
    m
      ? `width ${m.width}px (menu ${m.menu}, builder ${m.builder}), overflow ${m.overflow}px, needs [${[...new Set(m.needs)].join(",")}]` +
        (m.cells.length > 0
          ? `; overflowing cells: ${m.cells.join(" | ")}`
          : "")
      : "no panel";

  // ── Filter popover: builder-wide whether or not it has rules ──────────
  const filter = page.getByRole("button", { name: /^Filter(:|$)/ }).first();
  await filter.click({ force: true });
  await page.waitForTimeout(1000);
  const f = await measure();
  await snap(page, out, "filter");
  r.ok(
    "Filter popover is builder-wide",
    f !== null && f.width === f.builder && f.overflow <= 1,
    describe(f),
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  // ── View settings → Fold rows ─────────────────────────────────────────
  const settings = page
    .getByRole("button", { name: /^View settings(:|$)/ })
    .first();
  await settings.click({ force: true });
  await page.waitForTimeout(1000);
  const s = await measure();
  await snap(page, out, "settings");
  r.ok(
    "View settings opens menu-wide",
    s !== null && s.width === s.menu && s.overflow <= 1,
    describe(s),
  );

  // The row is named by its value ("Off" / "Keep …"); its band is labelled.
  const foldRow = page
    .locator(".cp-surface [data-cp-showing] .cp-band", { hasText: "Fold rows" })
    .locator("button.cp-row")
    .first();
  r.ok("settings has a Fold rows row", (await foldRow.count()) > 0, "");
  if ((await foldRow.count()) > 0) {
    await foldRow.click();
    await page.waitForTimeout(800);
    const fold = await measure();
    await snap(page, out, "fold-empty");
    r.ok(
      "Fold rows (empty) widens to builder",
      fold !== null && fold.width === fold.builder && fold.overflow <= 1,
      describe(fold),
    );

    // Add a rule over `foldField`, unless the fold already has rules.
    const hasRule = await page
      .locator(".cp-surface [data-cp-showing] .cp-rule")
      .count();
    if (hasRule === 0) {
      await page
        .locator(".cp-surface [data-cp-showing] button.cp-row", {
          hasText: foldField,
        })
        .first()
        .click();
      await page.waitForTimeout(800);
    }
    const ruled = await measure();
    await snap(page, out, "fold-rule");
    r.ok(
      "Fold rows with a rule stays builder-wide, nothing overflows",
      ruled !== null &&
        ruled.width === ruled.builder &&
        ruled.overflow <= 1 &&
        ruled.needs.includes("builder"),
      describe(ruled),
    );

    if (falsify) {
      const errors: string[] = [];
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text());
      });
      await page.evaluate(() => {
        for (const el of document.querySelectorAll(
          ".cp-surface [data-cp-needs]",
        ))
          el.removeAttribute("data-cp-needs");
        const cell = document.querySelector(
          ".cp-surface [data-cp-showing] [data-cp-cell='value']",
        );
        const rigid = document.createElement("div");
        rigid.style.cssText = "width:260px;min-width:260px;height:1px";
        cell?.appendChild(rigid);
      });
      await page.waitForTimeout(1500);
      const stripped = await measure();
      await snap(page, out, "falsified");
      r.ok(
        "falsified: a menu-wide panel holding a rigid control overflows",
        stripped !== null &&
          stripped.width === stripped.menu &&
          stripped.overflow > 1,
        describe(stripped),
      );
      // The guard files a `panel-overflow` report (a POST, not a console
      // line); check the worktree DB's reports for it after the run.
      console.log("   console errors after falsifying:", errors.length);
    }

    // Back to the settings root: menu width again.
    await page
      .locator(".cp-surface")
      .getByRole("button", { name: "Fold rows", exact: true })
      .first()
      .click();
    await page.waitForTimeout(600);
    const back = await measure();
    r.ok(
      "back on the settings root returns to menu width",
      back !== null && back.width === back.menu,
      describe(back),
    );
  }
});
