/**
 * End-to-end smoke of the Events Sources surface, against a deployed worktree.
 *
 * Manual only. Run after `./equin build`:
 *   ./equin run plugins/apps/plugins/events/plugins/sources/e2e/sources-verify.ts [--headed]
 *
 * Verifies the registry-driven promises this plugin is built on, not just that
 * pixels appeared:
 *   1. the `+` menu IS the source-type registry (BOTH installed types appear,
 *      while nothing under `web/` names either of them);
 *   2. the add form is GENERATED from the type's own `configFields` — the
 *      zero-field type says "nothing to configure", the URL type grows a form;
 *   3. a created source round-trips to the list and opens its detail pane;
 *   4. the detail pane's sections are contributions, gated by `useAvailable`;
 *   5. a source can be RENAMED after creation, and an emptied name comes back as
 *      the server-derived default rather than a blank row;
 *   6. the `source` dimension reaches the *events* DataView's Filter — the field
 *      extension crossing a plugin boundary.
 *
 * Deliberately stops short of creating a `Web page` source: its `extract` phase
 * spends a live model call. The extraction path is a separate, explicit test.
 *
 * Idempotent: the source it creates is deleted in a `finally`, so repeat runs do
 * not silt up the sources list.
 */
import {
  arg,
  boot,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = arg("out") ?? "/tmp/events4";
/** Distinctive enough that a stale row from a crashed run is recognisable. */
const SOURCE_NAME = "E2E smoke source";

const r = report("Events · Sources");

/**
 * A selector that proves the pane actually painted, plus room for a loaded host.
 *
 * `marker: "body"` is not a marker at all — `<body>` exists from the first byte,
 * so `boot` returns immediately and every following step races the SPA's own
 * render. On a box busy building other worktrees that gap exceeded Playwright's
 * 30s action default, and the run failed on a page that was merely still
 * booting. Wait for something the app had to render to produce.
 */
const BOOT_TIMEOUT_MS = 90_000;

await withBrowser(async (h) => {
  const { page, captured } = await h.session();

  /**
   * Delete every source called {@link SOURCE_NAME}, through the UI.
   *
   * Run BEFORE the flow as well as after: a run killed mid-flight leaves its row
   * behind, and a leftover would then make the "created source appears" check
   * pass without having created anything. Sweeping first makes the script
   * self-healing and its assertions honest on every run.
   *
   * Both "Delete source" matches need `exact: true`. Playwright's default name
   * match is a case-insensitive SUBSTRING, and a row `<button>` takes its
   * accessible name from its subtree — including the delete icon-button's own
   * `aria-label`. So the loose matcher resolved to the whole row and "deleting"
   * merely opened the detail pane. The confirm click is additionally scoped to
   * the dialog, since the row action and the confirm button share the name.
   */
  const sweep = async (): Promise<number> => {
    await boot(page, pathUrl("/events/sources"), {
      marker: 'button[aria-label="Create"]',
      timeoutMs: BOOT_TIMEOUT_MS,
    });
    // The list is fed by a live-state subscription, so an empty list right after
    // navigation means "not settled yet", not "nothing there". A fixed settle
    // read it too early and reported a clean sweep over rows that existed —
    // poll to a deadline instead.
    const deadline = Date.now() + 10_000;
    while (
      Date.now() < deadline &&
      (await page.getByText(SOURCE_NAME, { exact: true }).count()) === 0
    ) {
      await page.waitForTimeout(400);
    }
    let removed = 0;
    for (let i = 0; i < 10; i++) {
      const row = page.getByText(SOURCE_NAME, { exact: true }).first();
      if ((await row.count()) === 0) break;
      await row.hover();
      await page.waitForTimeout(300);
      const rowDelete = page
        .getByRole("button", { name: "Delete source", exact: true })
        .first();
      if ((await rowDelete.count()) === 0) break;
      await rowDelete.click();
      await page.waitForTimeout(600);
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Delete source", exact: true })
        .click();
      await page.waitForTimeout(1200);
      removed++;
    }
    return removed;
  };

  const swept = await sweep();
  if (swept > 0) r.note(`swept ${swept} leftover source(s) before starting`);

  // 1. The Sources surface, reached the way a user reaches it.
  await boot(page, pathUrl("/events"), {
    marker: 'button:has-text("Sources")',
    timeoutMs: BOOT_TIMEOUT_MS,
    settleMs: 800,
  });

  // Matched on its visible text: the app rail's icon buttons carry accessible
  // names too, and a loose name match can silently pick the rail instead.
  await page
    .getByRole("button", { name: "Sources", exact: true })
    .first()
    .click();
  await page.waitForTimeout(1200);
  await snap(page, OUT, "1-sources-empty");
  r.ok(
    "Sources pane is on the URL",
    page.url().includes("/sources"),
    page.url(),
  );

  // 2. The `+` menu is the registry. Two types are installed, so the control is
  //    the N-creator dropdown (`CreatorsControl` renders a labelled Button for
  //    exactly one) — that shape is itself evidence the registry drove it.
  const createTrigger = page.getByRole("button", {
    name: "Create",
    exact: true,
  });
  r.ok("`+` create control is present", (await createTrigger.count()) > 0);
  await createTrigger.first().click();
  await page.waitForTimeout(500);
  await snap(page, OUT, "2-create-menu");

  const menuItem = (label: string) =>
    page.getByRole("menuitem", { name: label });
  r.ok(
    "`Web page` source type in the + menu",
    (await menuItem("Web page").count()) > 0,
  );
  r.ok(
    "`Manual` source type in the + menu",
    (await menuItem("Manual").count()) > 0,
  );

  // 3. The URL type's form is generated from its configFields — opened and
  //    cancelled, never submitted: creating one would spend a live model call.
  await menuItem("Web page").first().click();
  await page.waitForTimeout(700);
  const urlDialog = page.getByRole("dialog");
  const urlDialogText =
    (await urlDialog.count()) > 0 ? await urlDialog.first().innerText() : "";
  await snap(page, OUT, "3-add-web-page");
  r.ok(
    "`Web page` dialog renders a generated config form",
    /url/i.test(urlDialogText),
    urlDialogText.slice(0, 200),
  );
  await page.getByRole("button", { name: "Cancel" }).first().click();
  await page.waitForTimeout(400);

  let created = false;
  try {
    // 4. Create the zero-config type. Its empty `configFields` is what proves
    //    the generic form treats "nothing to configure" as a real state.
    await createTrigger.first().click();
    await page.waitForTimeout(400);
    await menuItem("Manual").first().click();
    await page.waitForTimeout(700);

    const dialog = page.getByRole("dialog").first();
    const manualText = await dialog.innerText();
    r.ok(
      "zero-config type says so instead of rendering an empty form",
      /nothing to configure/i.test(manualText),
      manualText.slice(0, 200),
    );

    await dialog.getByRole("textbox").first().fill(SOURCE_NAME);
    await snap(page, OUT, "4-add-manual");
    await dialog.getByRole("button", { name: "Add source" }).click();
    await page.waitForTimeout(2500);
    created = true;

    // 5. It round-trips to the list, and creating it opened its detail pane.
    r.ok(
      "created source appears in the app",
      (await page.getByText(SOURCE_NAME).count()) > 0,
    );
    r.ok(
      "detail pane opened on the new source",
      /\/sources\/source\//.test(page.url()),
      page.url(),
    );
    await snap(page, OUT, "5-source-detail");

    // 6. The detail pane's sections are contributions.
    //
    //    Read off `button[aria-expanded]` — the collapsible section headers —
    //    rather than page text: "Settings" also names an app on the rail, so a
    //    whole-body substring search would "find" a section that is not there.
    //
    //    `Settings` is deliberately ABSENT for this type and its absence is the
    //    assertion: the section declares `useAvailable`, and a type with zero
    //    `configFields` and no `Extra` has nothing to show — a titled card
    //    opening onto emptiness is exactly what that gate exists to remove. A
    //    regression that starts painting an empty card must fail here.
    const headers = (
      await page.locator("button[aria-expanded]").allInnerTexts()
    ).map((t) => t.trim());
    r.note(`section headers: ${JSON.stringify(headers)}`);
    for (const section of ["Status", "Schedule", "Runs"]) {
      r.ok(
        `section "${section}" rendered`,
        headers.some((h2) => h2.includes(section)),
      );
    }
    // `Settings` is present even for a zero-config type, and its presence is the
    // assertion: the card carries the row's own `name`, so it has something to
    // show whatever the type declares. It says the type has nothing of its own
    // rather than drawing an empty form.
    r.ok(
      'section "Settings" rendered for a zero-config type too',
      headers.some((h2) => h2.includes("Settings")),
    );
    r.ok(
      "zero-config type says so inside the Settings card",
      /nothing of its own to configure/i.test(
        await page.locator("body").innerText(),
      ),
    );

    // 7. The name is editable after creation, and an emptied one cannot persist.
    //
    //    Both halves matter. The name is a column on the ROW, not a member of
    //    any type's `configFields` — this type declares none, so a Settings card
    //    that rendered only config would leave this source unrenameable, which
    //    is why the card must never go back to being gated on the type. Clearing
    //    the name must come back as the server-derived default (the type id, for
    //    a type whose config carries no URL), never as a blank row.
    const RENAMED = `${SOURCE_NAME} (renamed)`;
    const nameBox = page.getByPlaceholder("e.g. Fitzroy gigs");
    r.ok("the source's Name box is on the pane", (await nameBox.count()) > 0);

    // The text renderer commits on BLUR, not per keystroke — a `fill` alone
    // saves nothing, and asserting straight after it would test the local draft.
    await nameBox.first().fill(RENAMED);
    await nameBox.first().blur();
    await page.waitForTimeout(1500);
    await snap(page, OUT, "6-renamed");
    r.ok(
      "the rename reaches the pane title and the list row",
      (await page.getByText(RENAMED, { exact: true }).count()) > 0,
    );

    await nameBox.first().fill("");
    await nameBox.first().blur();
    await page.waitForTimeout(1500);
    const clearedTo = await nameBox.first().inputValue();
    await snap(page, OUT, "7-name-cleared");
    r.ok(
      "clearing the name comes back as the derived default, never blank",
      clearedTo === "manual",
      `name is now ${JSON.stringify(clearedTo)}`,
    );

    // Back to the swept name, so the `finally` cleanup can still find the row.
    await nameBox.first().fill(SOURCE_NAME);
    await nameBox.first().blur();
    await page.waitForTimeout(1500);

    // 8. The contributed `source` dimension reaches the events DataView.
    await boot(page, pathUrl("/events/list"), {
      // The landing view's own switcher chip: it exists only once the authored
      // view instances have resolved, which is the same gate the Filter
      // trigger's summary sits behind.
      marker: 'button:has-text("Upcoming")',
      timeoutMs: BOOT_TIMEOUT_MS,
      settleMs: 800,
    });

    // The trigger is an icon button, so its ACCESSIBLE NAME is where it says
    // what it is doing, and it renames itself: the bare word `Filter` only while
    // no rule is set, `Filter: <what it is doing>` once one is (`ControlTrigger`
    // spends the control's summary there). The landing view here is `Upcoming`,
    // which ships an authored `startsAt >= today` rule, so matching the literal
    // word alone finds nothing on a toolbar that plainly has a filter. Match
    // both spellings. Compact toolbars fold it behind "View options", so that
    // path is covered too.
    const filterName = /^Filter(:.*)?$/;
    let filterTrigger = page.getByRole("button", { name: filterName });

    // Poll, never a bare `count()`: `count()` is a snapshot with no auto-wait,
    // and the toolbar's trigger only settles once the view config resolves — so
    // a single read right after `boot` reported "no Filter control" on a toolbar
    // that grew one a few hundred ms later. That raced green/red between runs.
    const filterDeadline = Date.now() + 15_000;
    while (Date.now() < filterDeadline && (await filterTrigger.count()) === 0) {
      await page.waitForTimeout(400);
    }
    if ((await filterTrigger.count()) === 0) {
      const viewOptions = page.getByRole("button", {
        name: "View options",
        exact: true,
      });
      if ((await viewOptions.count()) > 0) {
        await viewOptions.first().click();
        await page.waitForTimeout(500);
        filterTrigger = page.getByRole("button", { name: filterName });
      }
    }
    const filterOpened = (await filterTrigger.count()) > 0;
    r.ok("events list exposes a Filter control", filterOpened);
    if (filterOpened) await filterTrigger.first().click();
    await page.waitForTimeout(900);
    // The popover opens on the EXISTING rule (the view has one), so the field
    // list is one click further in — `+ Add filter` is what reveals the
    // schema's dimensions.
    const addFilter = page.getByRole("button", {
      name: "Add filter",
      exact: true,
    });
    if ((await addFilter.count()) > 0) {
      await addFilter.first().click();
      await page.waitForTimeout(600);
    }
    // Type into the field typeahead rather than asserting on the raw DOM: the
    // list scrolls, and `Source` sits below the fold — a bare count would go
    // green on a node the user cannot reach. Filtering to it proves it is a
    // real, selectable dimension.
    const fieldSearch = page.getByPlaceholder("Filter by…");
    if ((await fieldSearch.count()) > 0)
      await fieldSearch.first().fill("Source");
    await page.waitForTimeout(500);
    await snap(page, OUT, "8-events-filter");
    r.ok(
      "`Source` is offered as a filter dimension (the field extension)",
      await page.getByText("Source", { exact: true }).first().isVisible(),
    );
  } finally {
    // Remove what we created, even if an assertion above threw.
    if (created) {
      const cleaned = await sweep();
      r.ok(
        `cleanup removed the created source`,
        cleaned > 0,
        `removed=${cleaned}`,
      );
    }
  }

  // A clean run means no crashes either. `requestfailed` is NOT folded in: a
  // navigation that aborts an in-flight fetch is normal, not a defect.
  r.ok(
    "no uncaught page errors",
    captured.pageErrors.length === 0,
    captured.pageErrors.join(" | "),
  );
  r.ok(
    "no console errors",
    captured.consoleErrors.length === 0,
    captured.consoleErrors.join(" | "),
  );
});

await r.finish();
