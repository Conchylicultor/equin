/**
 * End-to-end check of the sources list's `open` row action, against a deployed
 * worktree.
 *
 * Manual only. Run after `./equin build`:
 *   ./equin run plugins/apps/plugins/events/plugins/sources/e2e/open-source-page-verify.ts [--headed]
 *
 * Each step is written against a claim the action is built on, not a pixel:
 *
 *   1. it is a real LINK, not a button calling `window.open`. That is the whole
 *      reason it renders an `<a>` — the browser previews the destination on
 *      hover and its own link gestures work — and none of that survives a
 *      button;
 *   2. every destination is an ordinary `http(s)` address opening in a new tab.
 *      A source's URL is read out of a free-text config field, so the gate is
 *      `useEventSourceOrigin`'s, and a relative or `javascript:` string must
 *      never reach an href;
 *   3. the action belongs to ITS row — matched by geometry, because every row's
 *      cluster is in the DOM at all times (the reveal couples opacity with
 *      pointer-events) and a page-wide match returns a neighbour's just as
 *      happily;
 *   4. a source type that stands for no page renders NOTHING rather than a dead
 *      button. `manual` is that type — the user IS the extractor — so its rows
 *      are the assertion.
 *
 * Read-only: it opens no tab and writes nothing, so it is safe against a
 * populated instance and needs no cleanup. It deliberately never CLICKS the
 * link: following it would fetch a third-party site, and what a browser does
 * with an `<a target="_blank">` is not this app's behaviour to test.
 */
import {
  arg,
  boot,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = arg("out") ?? "/tmp/events-open-source-page";

/** See `sources-verify.ts`: a marker the app had to render, and room for it. */
const BOOT_TIMEOUT_MS = 90_000;

/**
 * How far from a row's own label an action may sit and still be that row's.
 * Half of a `md` list row (44px) plus slack — a neighbouring row's control is a
 * full row height away, so this cannot pick the wrong one.
 */
const ROW_HALF_HEIGHT_PX = 26;

/** The type that stands for no page: the user is the extractor. */
const NO_PAGE_TYPE = "manual";

interface SourceRow {
  id: string;
  name: string;
  type: string;
}

const r = report("Events · open source page");

await withBrowser(async (h) => {
  const { page, captured } = await h.session();

  await boot(page, pathUrl("/events/sources"), {
    marker: 'button[aria-label="Create"]',
    timeoutMs: BOOT_TIMEOUT_MS,
    settleMs: 1200,
  });

  const res = await page.request.get(pathUrl("/api/events/sources"));
  if (!res.ok()) throw new Error(`GET /api/events/sources — ${res.status()}`);
  const sources = (await res.json()) as SourceRow[];
  r.note(`${sources.length} configured source(s)`);

  /**
   * The open link belonging to the row whose label reads `name`, or `null` when
   * that row offers none.
   *
   * Hover the label first (it sits inside the row's primary button, a sibling of
   * the actions cluster under the row container, so hovering it hovers the
   * container that owns the reveal), then keep only the link whose vertical
   * centre lies inside that row's band.
   */
  const openLinkOf = async (name: string): Promise<string | null> => {
    const label = page.getByText(name, { exact: true }).first();
    if ((await label.count()) === 0) return null;
    await label.scrollIntoViewIfNeeded();
    await label.hover();
    await page.waitForTimeout(250);
    const rowBox = await label.boundingBox();
    if (rowBox === null) return null;
    const rowCentre = rowBox.y + rowBox.height / 2;

    const links = page.locator('a[aria-label="Open source page"]');
    for (let i = 0; i < (await links.count()); i++) {
      const link = links.nth(i);
      const box = await link.boundingBox();
      if (box === null) continue;
      if (Math.abs(box.y + box.height / 2 - rowCentre) > ROW_HALF_HEIGHT_PX)
        continue;
      return await link.evaluate(
        (el) => `${el.getAttribute("href")} ${el.getAttribute("target")}`,
      );
    }
    return null;
  };

  let withPage = 0;
  for (const source of sources) {
    const found = await openLinkOf(source.name);
    const standsForNoPage = source.type === NO_PAGE_TYPE;

    if (standsForNoPage) {
      // 4. Absence IS the assertion for this type.
      r.ok(
        `\`${source.name}\` (${source.type}) offers no page to open`,
        found === null,
        found ?? "no link",
      );
      continue;
    }
    if (found === null) {
      // Not a failure by itself: a row whose stored config no longer fits its
      // type's fields honestly has no destination, and the Settings section is
      // where that is reported. Say so rather than gating on it.
      r.note(`\`${source.name}\` (${source.type}) offers no page — no origin`);
      continue;
    }

    // 1–3. A real link, to an ordinary web address, in a new tab, on this row.
    const [href, target] = found.split(" ");
    withPage++;
    r.ok(
      `\`${source.name}\` opens an http(s) page in a new tab`,
      /^https?:\/\//.test(href ?? "") && target === "_blank",
      found,
    );
  }

  r.ok(
    "at least one source offered its page",
    withPage > 0,
    `${withPage} of ${sources.length}`,
  );

  // The first row, hovered, with its cluster revealed — the shot is the record
  // of what a person actually sees.
  const first = sources[0];
  if (first) await openLinkOf(first.name);
  await snap(page, OUT, "1-sources-hovered");

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
