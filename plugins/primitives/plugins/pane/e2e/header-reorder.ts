/**
 * Pins the capability the one-pane-header-slot refactor exists for
 * (`research/2026-08-21-global-one-pane-header-slot.md`): **a pane header's
 * items are reorderable**.
 *
 * Before it, a pane's `Actions` were painted by `useContributions()` +
 * `renderIsolated` rather than by the slot's own `.Render`, so the reorder LIST
 * middleware never ran: ordering, hiding and spacers were silently ignored on
 * every one of the ~106 pane headers, even though each owed a config directive.
 * Nothing failed — the directives simply had no effect, which is precisely the
 * kind of absence a screenshot cannot show. The header now renders through
 * `.Render` inside an `AdaptiveBar`, so its items are sortable dnd-kit items
 * like any other reorderable slot's.
 *
 * What is asserted, per surface:
 *
 *  0. Edit mode OFF ⇒ the header band holds ZERO sortables. This is the
 *     baseline that makes the ON reading mean "edit mode did it" rather than
 *     "something in this band is always sortable".
 *  1. Edit mode ON ⇒ the band holds sortables at all (non-vacuity: without this
 *     every count below could be a mis-scoped locator reading an empty band).
 *  2. Every header CONTRIBUTION in the band is itself a sortable item — not
 *     merely inside one, and not merely some of them.
 *  3. The band's sortables are EXACTLY the contributions plus the reorder
 *     config's spacers, so no count is left unexplained.
 *  4. Edit mode OFF again ⇒ back to zero, and the session is left as it was
 *     found.
 *
 * Edit mode MUST be on for any of this to be visible: an area's drag host
 * (the `DeferredSortableList` registrations that hand each item its dnd-kit
 * attributes) is mounted only in edit mode — so the
 * `aria-roledescription="sortable"` marker is absent outside edit mode. Step 0
 * asserts that absence rather than assuming it.
 *
 * Three surfaces, because a pane header came in three shapes:
 *
 *  - `/events/sources` — an ORDINARY pane whose header is its plain `Actions`
 *    slot. This is the surface the refactor is for, and the only one that
 *    discriminates: run this script against the pre-refactor deploy
 *    (`--url http://singularity.localhost:9000`) and this pane reports
 *    `sortables in band=0` with edit mode ON, because `renderIsolated` painted
 *    its actions outside the list middleware. Every other pane in the app that
 *    is not a rich custom header is this one.
 *  - the Sonata player — the pane's own header slot carrying a rich set of
 *    contributions (transport, volume, transpose, …).
 *  - `/website/apps` — a SHARED `definePaneHeaderSlot()` borrowed by the site's
 *    inner pages: one slot, several panes, one config directive. (The website's
 *    own homepage is deliberately NOT one of them — it wears no header at all —
 *    so this surface must stay an inner page, never `/website`.)
 *
 * The last two were `chrome.header` custom toolbars before the refactor, whose
 * `Start`/`End` zones already rendered through `.Render`; they are here because
 * the refactor collapsed all three shapes into ONE slot, and "the rich headers
 * still reorder" is the half of that claim a regression would break silently.
 *
 * Manual only — nothing runs this automatically.
 *
 *   bun plugins/primitives/plugins/pane/e2e/header-reorder.ts \
 *     [--url http://<worktree>.localhost:9000] [--song <id>] [--headed]
 */
import {
  arg,
  boot,
  pathUrl,
  report,
  withBrowser,
  type Session,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

/**
 * The harness's page, named through the harness rather than by importing
 * `playwright` here: this plugin does not depend on the driver, the harness
 * does.
 */
type Page = Session["page"];

const SORTABLE = '[aria-roledescription="sortable"]';
/** A contribution's lineage marker, stamped by `ui-context` on every one. */
const CONTRIBUTION = '[data-lineage="contribution"]';
/**
 * The pane-header band: the `pane`-tier `<Bar>` `PaneChrome` renders its header
 * `AdaptiveBar` into. `h-chrome-pane` is that tier's own height token and the
 * one class only this band wears — the app tab bar, the app rail and the
 * sidebars all carry sortables of their own, and counting those would make
 * every number below meaningless.
 */
const HEADER_BAND = ".h-chrome-pane";
/** The reorder editor's spacer placeholder, by the only control it owns. */
const SPACER = 'button[aria-label="Remove spacer"]';

interface Surface {
  name: string;
  /** Resolved per run — one surface needs a row click to reach an id'd route. */
  url: (page: Page) => Promise<string>;
}

const SURFACES: Surface[] = [
  {
    name: "events/sources (ordinary pane, plain Actions slot)",
    url: () => Promise.resolve(pathUrl("/events/sources")),
  },
  {
    name: "sonata player (pane's own header slot)",
    url: resolveSongUrl,
  },
  {
    name: "website/apps (shared header slot, borrowed by every inner page)",
    url: () => Promise.resolve(pathUrl("/website/apps")),
  },
];

const r = report("pane header reorder");

await withBrowser(async (h) => {
  const { page } = await h.session({ viewport: { width: 1600, height: 900 } });

  for (const s of SURFACES) {
    const url = await s.url(page);
    if (url === "") {
      r.fail(`${s.name}: reach the surface`, "no URL resolved — probe vacuous");
      continue;
    }
    await boot(page, url, { marker: HEADER_BAND, settleMs: 2500 });

    const bands = await page.locator(HEADER_BAND).count();
    // Exactly one band keeps "the header band" an unambiguous phrase: a
    // Miller-columns route paints several, and a scoped count over the wrong
    // one would be quietly wrong instead of loudly wrong.
    r.eq(`${s.name}: exactly one pane-header band`, bands, 1);
    if (bands !== 1) continue;

    const off = await readBand(page);
    r.eq(
      `${s.name}: edit mode OFF ⇒ no sortables in the header`,
      off.sortables,
      0,
    );

    if (!(await setEditMode(page, true))) {
      r.fail(
        `${s.name}: enter edit mode`,
        "pen button not found — probe vacuous",
      );
      continue;
    }

    const on = await readBand(page);
    r.note(
      `${s.name}: contributions=${on.contributions} sortable=${on.sortableContributions} ` +
        `spacers=${on.spacers} sortables in band=${on.sortables}` +
        (on.ids.length ? `\n        ${on.ids.join("\n        ")}` : ""),
    );

    // Non-vacuity FIRST: it proves edit mode engaged and the marker exists in
    // THIS band, so the equalities after it are about the header's items.
    r.ok(
      `${s.name}: edit mode ON ⇒ header holds sortables`,
      on.sortables > 0,
      `no sortable in the pane header (got ${on.sortables})`,
    );
    r.ok(
      `${s.name}: header has real actions beyond the title`,
      on.contributions > 1,
      `only ${on.contributions} contribution(s) — a title-only header proves nothing`,
    );
    r.eq(
      `${s.name}: every header contribution is exactly one sortable item`,
      on.sortableContributions,
      on.contributions,
    );
    r.eq(
      `${s.name}: band sortables = contributions + spacers`,
      on.sortables,
      on.contributions + on.spacers,
    );

    await setEditMode(page, false);
    const back = await readBand(page);
    r.eq(`${s.name}: edit mode OFF again ⇒ back to zero`, back.sortables, 0);
  }
});

await r.finish();

interface BandReading {
  /** Sortable items anywhere in the header band. */
  sortables: number;
  /** Header contributions rendered in the band (the pane title included). */
  contributions: number;
  /** Of those, how many hold EXACTLY ONE sortable item of their own. */
  sortableContributions: number;
  /** Spacer placeholders the slot's reorder config put in the row. */
  spacers: number;
  /** `<contribution-id> [sortables: n]`, for the transcript. */
  ids: string[];
}

/** Everything the assertions need, read from the one band in a single pass. */
async function readBand(page: Page): Promise<BandReading> {
  return await page.evaluate(
    ([bandSel, sortableSel, contributionSel, spacerSel]) => {
      const band = document.querySelector<HTMLElement>(bandSel);
      if (!band)
        return {
          sortables: -1,
          contributions: -1,
          sortableContributions: -1,
          spacers: -1,
          ids: ["band not found"],
        };
      const contributions = [
        ...band.querySelectorAll<HTMLElement>(contributionSel),
      ];
      // Exactly ONE sortable per contribution. The reorder middleware wraps
      // each rendered contribution in its own item, so zero means that
      // contribution is not movable, and two would mean a nested reorder area
      // registered a second dnd-kit id under the same header entry.
      const sortable = contributions.filter(
        (c) => c.querySelectorAll(sortableSel).length === 1,
      );
      return {
        sortables: band.querySelectorAll(sortableSel).length,
        contributions: contributions.length,
        sortableContributions: sortable.length,
        spacers: band.querySelectorAll(spacerSel).length,
        ids: contributions.map(
          (c) =>
            `${c.getAttribute("data-contribution-id") ?? "?"} [sortables: ${
              c.querySelectorAll(sortableSel).length
            }]`,
        ),
      };
    },
    [HEADER_BAND, SORTABLE, CONTRIBUTION, SPACER] as const,
  );
}

/**
 * Flip global edit mode via the pen on the global action bar. That bar is a
 * hover-revealed floating panel when unpinned, so the button is in the DOM but
 * pointer-intercepted until the bar is disclosed — a blind click fails.
 *
 * Returns false when the toggle was not found, so the caller can fail loudly
 * instead of reading a zero that means "nothing happened".
 */
async function setEditMode(page: Page, on: boolean): Promise<boolean> {
  const bar = page.locator('[data-source*="floating-action"]').first();
  if (await bar.count()) {
    await bar.hover();
    await page.waitForTimeout(600);
  }
  const toggle = page.getByRole("button", {
    name: on ? "Reorder items" : "Exit edit mode",
  });
  if ((await toggle.count()) === 0) return false;
  await toggle.first().click();
  await page.waitForTimeout(800);
  return true;
}

/**
 * A Sonata song URL. `--song <id>` names one directly; otherwise the library is
 * driven the way a user reaches a song — click cards until the route becomes a
 * song — so the script carries no id belonging to one machine's database.
 */
async function resolveSongUrl(page: Page): Promise<string> {
  const id = arg("song");
  if (id) return pathUrl(`/sonata/song/${id}`);

  const library = pathUrl("/sonata");
  await boot(page, library, { marker: '[role="button"]', settleMs: 3000 });
  const cards = page.locator('[role="button"]');
  const count = Math.min(await cards.count(), 25);
  for (let i = 0; i < count; i++) {
    try {
      await cards.nth(i).click({ timeout: 2000 });
    } catch (err) {
      // A card that will not take a click — covered by another element, or
      // detached mid-scan — is this probe's EXPECTED negative, and Playwright
      // spells it as a timeout. Anything else (a crashed page, a bad selector)
      // is a real failure that must not be swallowed by a loop whose only job
      // is to find the first playable song.
      if (!(err instanceof Error) || err.name !== "TimeoutError") throw err;
      continue;
    }
    await page.waitForTimeout(1200);
    if (page.url().includes("/sonata/song/")) return page.url();
    if (!page.url().endsWith("/sonata")) await page.goto(library);
  }
  return "";
}
