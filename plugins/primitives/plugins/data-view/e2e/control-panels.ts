// Drives the DataView's three toolbar controls and captures each open panel.
//
// Verifies the control-panel vocabulary against a real surface: the Tasks list
// at /agents is a live wide DataView whose landing view ships an authored filter,
// so an ACTIVE control is on screen from first load. A narrow viewport reproduces
// the compact fold (the toolbar folds below 360px of container width), where the
// controls become a panel stack rather than nested popovers.
//
//   ./equin run plugins/primitives/plugins/data-view/e2e/control-panels.ts --out /tmp/cp
//   ./equin run plugins/primitives/plugins/data-view/e2e/control-panels.ts --headed
import {
  arg,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const out = arg("out", "/tmp/control-panels");
const url = pathUrl("/agents");

await withBrowser(async (h) => {
  const r = report("DataView control panels");
  const { page } = await h.session({
    viewport: { width: 1600, height: 1000 },
    colorScheme: "dark",
  });

  await page.goto(url);
  await page.waitForTimeout(4000);
  // `noWaitAfter`: the sidebar nav click schedules a client-side route change
  // that Playwright waits on indefinitely; the pane render is what we actually
  // wait for, below.
  await page
    .getByRole("button", { name: "Tasks", exact: true })
    .first()
    .click({ noWaitAfter: true });
  await page.waitForTimeout(2500);
  await snap(page, out, "toolbar");

  // Every trigger is icon-only, so its accessible name is the ONLY place the
  // closed state says anything: bare "Filter" while idle, "Filter: <summary>"
  // once the control is narrowing what you see.
  const triggers = await page.evaluate(() =>
    Array.from(document.querySelectorAll("button"))
      .map((b) => b.getAttribute("aria-label"))
      .filter(
        (l): l is string => !!l && /^(Filter|Sort|View settings)(:|$)/.test(l),
      ),
  );
  r.ok(
    "toolbar exposes control triggers",
    triggers.length >= 2,
    triggers.join(" | "),
  );

  // …and the summary must actually reach that name. The regex above matches the
  // bare word too, so on its own it would pass with every summary returning
  // null. This surface's landing view carries an authored `status is none of
  // [done, dropped]` rule (config/tasks/task-list/tasks-list.jsonc), so at least
  // one trigger MUST be named "<label>: <what it is doing>".
  r.ok(
    "an active control's name carries its summary",
    triggers.some((l) => l.includes(": ")),
    triggers.join(" | "),
  );

  for (const label of triggers) {
    const btn = page.getByRole("button", { name: label, exact: true }).first();
    if ((await btn.count()) === 0) continue;
    await btn.click({ force: true });
    await page.waitForTimeout(1200);
    await snap(page, out, label.replace(/\W+/g, "-").slice(0, 40));

    // Every panel must be ONE width per role and must carry no hand-placed
    // divider — the container draws them. We assert the panel exists and
    // report its measured width so a per-panel width drift is visible.
    const box = await page.evaluate(() => {
      const panel = document.querySelector(
        '[role="dialog"]',
      ) as HTMLElement | null;
      return panel ? Math.round(panel.getBoundingClientRect().width) : null;
    });
    r.ok(
      `panel opens: ${label}`,
      box !== null,
      box === null ? "no panel" : `width ${box}px`,
    );

    // A builder's pickers must be READABLE at the builder width. The whole
    // point of a fixed width role is that the row fits it — a truncated
    // "Sta…" / "Is no…" means the track ratios are wrong, which is exactly the
    // failure the old variable-width panel hid by growing instead.
    const cells = await page.evaluate(() => {
      const row = document.querySelector(
        "[data-cp-cell='field']",
      )?.parentElement;
      if (!row) return null;
      return Array.from(row.querySelectorAll("[data-cp-cell]")).map((el) => {
        // Any descendant may be the ellipsizing leaf (the picker's label span),
        // and it is NOT the first child — that is the leading type icon. Scan
        // them all, or the probe reports "readable" for a visibly clipped cell.
        const clipped = Array.from(el.querySelectorAll("*")).filter(
          (n) => n.scrollWidth > n.clientWidth + 1,
        );
        return {
          cell: el.getAttribute("data-cp-cell"),
          w: Math.round(el.getBoundingClientRect().width),
          truncates: clipped.length > 0,
          text: (el as HTMLElement).innerText.trim().slice(0, 24),
        };
      });
    });
    if (cells) {
      console.log(
        "   cells:",
        cells
          .map(
            (c) =>
              `${c.cell}=${c.w}px "${c.text}"${c.truncates ? " CLIPPED" : ""}`,
          )
          .join("  "),
      );
      const clipped = cells.filter((c) => c.truncates).map((c) => c.cell);
      r.ok(
        `builder cells readable: ${label}`,
        clipped.length === 0,
        cells.map((c) => `${c.cell}=${c.w}${c.truncates ? "!" : ""}`).join(" "),
      );
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  }

  // Compact fold: below 360px of CONTAINER width the toolbar folds every control
  // behind one trigger, and the controls become a panel STACK — a row push with
  // a back affordance, not a popover opened on top of a popover.
  //
  // Shrinking the viewport does NOT reproduce this: the Tasks pane stays far
  // wider than the breakpoint even at 900px, so the toolbar never folds and a
  // page-wide locator silently matches the WIDE toolbar's own trigger — an
  // assertion that passes without ever exercising the fold. The agent-manager
  // sidebar hosts a genuinely narrow DataView (the Queue / Models switcher), so
  // drive that one and scope every lookup inside the open panel.
  const optionsTrigger = page
    .getByRole("button", { name: "View options", exact: true })
    .first();
  const folded = (await optionsTrigger.count()) > 0;
  r.ok(
    "compact toolbar folds in the sidebar DataView",
    folded,
    "sidebar DataView sits below the 360px fold breakpoint",
  );

  if (folded) {
    await optionsTrigger.click({ force: true });
    await page.waitForTimeout(1000);
    await snap(page, out, "compact-root");

    const panel = page.locator('[role="dialog"]').first();
    const row = panel.getByRole("button", { name: /Filter|Sort/ }).first();
    if ((await row.count()) > 0) {
      await row.click({ force: true });
      await page.waitForTimeout(900);
      await snap(page, out, "compact-pushed");
      const panels = await page.evaluate(
        () => document.querySelectorAll('[role="dialog"]').length,
      );
      r.ok(
        "compact fold pushes a sub-panel instead of nesting a popover",
        panels === 1,
        `${panels} panel(s) open after the push`,
      );
    } else {
      r.ok(
        "compact fold lists its controls as rows",
        false,
        "no control row inside the folded panel",
      );
    }
  }

  await r.finish();
});
