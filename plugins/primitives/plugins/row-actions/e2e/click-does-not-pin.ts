/**
 * Verifies the reveal rule this primitive owns: a row's action cluster appears
 * while the pointer is over the row, and while KEYBOARD focus is on a button
 * inside the cluster — never because a click left focus somewhere in the row.
 *
 * Nothing but a browser can answer this. `:focus-visible` is a live UA decision
 * about how the last interaction happened, not a class the DOM carries: the same
 * button, focused by a mouse click and by a Tab keypress, differs only in a state
 * Chromium computes. A jsdom test can assert the class string; only a real
 * browser can say whether it matched.
 *
 *   ./equin run plugins/primitives/plugins/row-actions/e2e/click-does-not-pin.ts --headed
 *
 * Parameterized so one script covers several row families. `--url` is a base, as
 * everywhere in the harness, and `--path` is the app path under it:
 *
 *   --path 'agents/c/<id>' --row '[data-ui-owner^="CollapsibleCard"]'
 */
import {
  arg,
  boot,
  flag,
  numArg,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

/** Pages sidebar tree row — the selectors `row-actions-overflow.ts` proved stable. */
const ROW_SELECTOR = arg("row", '[data-ui-owner^="TreeRowChrome"]');
const ROW_TEXT = arg("row-text");
const ROW_INDEX = numArg("row-index", 0);
const MENU_TRIGGER = arg("menu-trigger", "More");
/** This surface's cluster has no overflow menu — see step 4. */
const NO_MENU = flag("no-menu");
const PATH = arg("path", "pages");
const OUT = arg("out") ?? "/tmp/row-actions-click";

/**
 * Where the row-BODY click lands, in px from the row's left edge. On a tree row
 * 14px is the disclosure chevron — the button the design doc names as what takes
 * focus when a user clicks a tree row. The label further right is not usable for
 * this: clicking it opens the page, and the detail pane's title field pulls focus
 * out of the row, so the pin has nothing to hold onto and the assertion would
 * pass without ever exercising the bug.
 */
const BODY_X = numArg("body-x", 14);

/** Long enough for `transition-opacity` (150ms) plus a slow frame. */
const SETTLE_MS = 1500;
/** Opacity is animated, so compare against the endpoint with a tolerance. */
const EPSILON = 0.02;
/** The cluster sits a handful of stops after the row in tab order. */
const TAB_CAP = 40;

await withBrowser(async (h) => {
  const r = report(`row actions — a click must not pin the cluster (${PATH})`);
  const { page, captured } = await h.session();

  await boot(page, pathUrl(PATH), { marker: ROW_SELECTOR });

  const rows = ROW_TEXT
    ? page.locator(ROW_SELECTOR).filter({ hasText: ROW_TEXT })
    : page.locator(ROW_SELECTOR);
  const row = rows.nth(ROW_INDEX);
  await row.waitFor({ state: "visible", timeout: 30_000 });
  r.note(
    `row: ${JSON.stringify((await row.textContent())?.trim().slice(0, 40))}`,
  );

  const viewport = page.viewportSize() ?? { width: 1400, height: 900 };

  /**
   * Per button in the row: the first ancestor-or-self whose computed opacity is
   * not 1 — the node the fade actually rides, since it lives on the cluster and
   * not on the buttons (`row-actions-overflow.ts` reads it the same way).
   *
   * `onSelf` is what separates the cluster from the row's own chrome. A tree
   * row's chevron ALSO sits at `opacity-0` at rest, so "faded" alone would
   * mistake it for an action — and it carries its own `focus-visible:opacity-100`,
   * so tabbing to it would satisfy the keyboard assertion below without the
   * cluster ever appearing. The cluster's buttons are opaque in themselves and
   * fade through an ancestor (the `Pin`); the chevron fades on itself.
   *
   * The walk STOPS at the row. Left unbounded it escapes into chrome that has
   * nothing to do with the cluster and reports that instead: on a transcript the
   * whole `JsonlPaneInner` sits at `opacity: 0.5`, so every button in every row
   * reads as "faded 0.5" and the reveal being measured is the pane's, not the
   * cluster's. A fade outside the row can never be the row's action reveal.
   */
  const probeButtons = () =>
    row.evaluate((rowEl) =>
      [...rowEl.querySelectorAll("button")].map((el) => {
        for (
          let n: HTMLElement | null = el as HTMLElement;
          n;
          n = n === rowEl ? null : n.parentElement
        ) {
          const o = getComputedStyle(n).opacity;
          if (o !== "1") return { opacity: Number(o), onSelf: n === el };
        }
        return { opacity: 1, onSelf: false };
      }),
    );

  // Discovered at rest, while the fade is the only thing distinguishing the
  // cluster: once revealed every ancestor reads opacity 1 and the walk finds
  // nothing to group by.
  const atRest = await probeButtons();
  const clusterIdx = atRest.flatMap((b, i) =>
    !b.onSelf && b.opacity !== 1 ? [i] : [],
  );
  const labels = await row
    .locator("button")
    .evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""));
  r.note(
    `cluster buttons: ${JSON.stringify(clusterIdx.map((i) => labels[i]))}`,
  );
  if (clusterIdx.length === 0) {
    r.fail(
      "the row has a hover-revealed action cluster",
      `no faded cluster under ${ROW_SELECTOR} — every assertion below would be vacuous`,
    );
    await r.finish();
  }
  const probeIdx = clusterIdx[0]!;

  const clusterOpacity = async (): Promise<number> => {
    const b = (await probeButtons())[probeIdx];
    if (!b)
      throw new Error(`cluster button #${probeIdx} vanished from the row`);
    return b.opacity;
  };

  /** Read the cluster once the transition has landed on `want` (or given up). */
  const settledOpacity = async (want: number): Promise<number> => {
    const deadline = Date.now() + SETTLE_MS;
    let seen = await clusterOpacity();
    while (Math.abs(seen - want) > EPSILON && Date.now() < deadline) {
      await page.waitForTimeout(50);
      seen = await clusterOpacity();
    }
    return seen;
  };

  const assertOpacity = async (name: string, want: number) => {
    const seen = await settledOpacity(want);
    r.ok(
      name,
      Math.abs(seen - want) <= EPSILON,
      `cluster opacity ${seen}, want ${want}`,
    );
  };

  const focusInRow = () =>
    row.evaluate((el) => el.contains(document.activeElement));
  const focusInCluster = () =>
    row
      .locator("button")
      .evaluateAll(
        (els, idxs) =>
          els.some(
            (el, i) =>
              (idxs as number[]).includes(i) &&
              el.contains(document.activeElement),
          ),
        clusterIdx,
      );

  /**
   * Park the pointer in the far corner and PROVE the row lost `:hover`. Every
   * "the cluster is hidden" assertion is vacuous the other way round if the row
   * is somehow still hovered — it would then be asserting nothing at all.
   */
  const parkPointer = async (label: string) => {
    await page.mouse.move(viewport.width - 40, viewport.height - 40);
    await page.waitForTimeout(100);
    const hovered = await row.evaluate((el) => el.matches(":hover"));
    r.ok(
      `row lost hover (${label})`,
      !hovered,
      "pointer parked but the row still matches :hover",
    );
  };

  // --- 1. Hover reveals -------------------------------------------------------
  // The anti-vacuity guard for everything below: a cluster that never appears
  // would pass every hidden-state assertion in this file.
  await row.hover();
  await assertOpacity("hover reveals the cluster", 1);
  await snap(page, OUT, "hovered");
  if (r.failures.length > 0) {
    r.note(
      "the cluster never reveals — the assertions below cannot mean anything",
    );
    await r.finish();
  }

  // --- 2. A click on the row body must not pin it -----------------------------
  // The reported bug. `group-focus-within/row-actions` asked the focus question
  // about the whole ROW, and a click puts focus inside the row on every surface
  // we ship, so the actions stayed on screen after the pointer left.
  const box = (await row.boundingBox())!;
  await row.click({ position: { x: BODY_X, y: box.height / 2 } });
  await page.waitForTimeout(200);
  r.ok(
    "the body click put focus inside the row",
    await focusInRow(),
    `nothing in the row took focus at x=${BODY_X}px — there is no pin to detect, so the next assertion would pass for free`,
  );
  await parkPointer("after body click");
  await assertOpacity("a click on the row body does not pin the cluster", 0);
  await snap(page, OUT, "after-body-click");

  // --- 3. The keyboard still reaches the cluster ------------------------------
  // The pointer is still parked away, so hover cannot be what reveals it here.
  // It must be a real Tab keypress: Chromium does not mark a mouse-clicked (or
  // programmatically `.focus()`ed) button as focus-visible, so driving focus by
  // script would fail this for a reason that has nothing to do with the app.
  let tabs = 0;
  while (tabs < TAB_CAP && !(await focusInCluster())) {
    await page.keyboard.press("Tab");
    tabs++;
  }
  if (tabs >= TAB_CAP && !(await focusInCluster())) {
    r.fail(
      "Tab reaches the action cluster",
      `${TAB_CAP} presses without landing inside it — the cluster may be out of the tab sequence`,
    );
  } else {
    r.ok(`Tab reaches the action cluster (${tabs} presses)`, true);
    await assertOpacity("keyboard focus inside the cluster reveals it", 1);
  }
  await snap(page, OUT, "tabbed");

  // --- 4. Mouse-driven focus on an action must not pin it ---------------------
  // The half plain `focus-within` cannot pass: closing the menu hands focus back
  // to the `⋯` INSIDE the cluster, so containment alone still holds it open.
  // Only `:focus-visible` distinguishes it, because the last interaction was a
  // mouse. The second click is `force`d: the open menu's backdrop covers the
  // trigger, so Playwright's actionability check would refuse it. The gesture is
  // still a genuine mouse click at the trigger's own coordinates, and what it
  // proves is unchanged — the menu closes and focus lands back on the trigger,
  // by mouse.
  // Not every cluster HAS an overflow menu — a transcript row's is two plain
  // buttons. `--no-menu` is an explicit opt-out rather than a silent skip: the
  // operator has to assert that this surface has no menu, so the step can never
  // quietly vanish on a surface that does have one and regressed.
  const more = row.getByRole("button", { name: MENU_TRIGGER, exact: true });
  if (NO_MENU) {
    r.note(
      "skipped: --no-menu — this surface has no overflow menu, so the " +
        "mouse-focus half is proved on the surfaces that do, not here",
    );
  } else if ((await more.count()) === 0) {
    r.fail(
      `the row has a "${MENU_TRIGGER}" menu trigger`,
      "no trigger to mouse-focus, so the focus-visible half is unproven here — pass --menu-trigger",
    );
  } else {
    await row.hover();
    await more.click();
    const menu = page.getByRole("menu");
    await menu.waitFor({ state: "visible", timeout: 10_000 });
    await more.click({ force: true });
    await menu.waitFor({ state: "detached", timeout: 10_000 });
    r.ok(
      "closing the menu leaves focus inside the row",
      await focusInRow(),
      "focus went elsewhere, so there is no mouse-focus left to pin the cluster",
    );
    await parkPointer("after menu close");
    await assertOpacity(
      "mouse-driven focus on an action does not pin the cluster",
      0,
    );
    await snap(page, OUT, "after-menu-close");
  }

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
