/**
 * Verifies the page outline: it lists the page's headings in document order at
 * the right depth, jumps to the heading a row names, and reports the section
 * being read as the current one.
 *
 * The last of those is the assertion worth having. Everything else about this
 * feature looks correct while the position indicator is dead — the dashes paint,
 * the panel opens, the clicks land — so a test that only exercises navigation
 * passes on a rail that is merely a jump list. The conversation's own e2e caught
 * exactly that (the scroll-spy's enrollment could not retry once the scroll
 * container arrived late), which is why this one asserts the same property for
 * the other consumer.
 *
 *   ./equin run plugins/apps/plugins/pages/plugins/page-outline/e2e/page-outline-verify.ts --page <blockId>
 */
import {
  arg,
  boot,
  pathUrl,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { Page } from "playwright";

// The rail's published DOM contract (see the rail's own CLAUDE.md). Pinned to
// the label this plugin passes, so a conversation rail on screen is never read.
const RAIL = '[data-outline-rail][aria-label="Page outline"]';
const ROW = `${RAIL} [data-outline-row]`;
const ACTIVE_DASH = `${RAIL} [data-outline-dash][data-active="true"]`;
const SETTLE_MS = 2500;

const pageId = arg("page") ?? "block-996c4c73-baa6-4cc0-9417-3559e5293b99";

/**
 * Escape a value for a DOUBLE-QUOTED attribute selector, from Node — `CSS.escape`
 * is a browser global and does not exist in this script's own scope.
 */
function attrValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Hover the rail and wait for its panel rows to be interactable. */
async function openPanel(page: Page): Promise<void> {
  await page.hover(RAIL);
  // The panel grows from zero height; a click mid-transition misses.
  await page.waitForSelector(ROW, { state: "visible", timeout: 5000 });
  await page.waitForTimeout(300);
}

/** The outline's own view of the page, in panel order. */
async function panelEntries(
  page: Page,
): Promise<{ id: string; label: string; indent: number }[]> {
  return page.$$eval("[data-outline-row]", (nodes) =>
    nodes.map((n) => ({
      id: n.getAttribute("data-outline-id") ?? "",
      label: (n.textContent ?? "").trim(),
      // Depth is rendered as left padding; the exact ramp is the rail's
      // business, so this only ever compares one row's indent against another's.
      indent: Math.round(
        parseFloat(getComputedStyle(n).paddingLeft || "0") ||
          parseFloat(
            getComputedStyle(n.firstElementChild ?? n).paddingLeft || "0",
          ) ||
          0,
      ),
    })),
  );
}

/** The heading blocks the editor actually rendered, in DOM order. */
async function renderedHeadings(
  page: Page,
): Promise<{ id: string; level: number; text: string }[]> {
  return page.$$eval("[data-block-id]", (nodes) =>
    nodes
      .map((n) => {
        const line = n.querySelector('[role="heading"]');
        if (!line) return null;
        const level = Number(line.getAttribute("aria-level") ?? "0");
        return {
          id: n.getAttribute("data-block-id") ?? "",
          level,
          text: (line.textContent ?? "").trim(),
        };
      })
      .filter(
        (v): v is { id: string; level: number; text: string } => v !== null,
      ),
  );
}

/** Which heading the outline currently calls the one being read. */
async function activeId(page: Page): Promise<string | null> {
  const dash = await page.$(ACTIVE_DASH);
  return dash ? dash.getAttribute("data-outline-id") : null;
}

await withBrowser(async (h) => {
  const r = report("page outline");
  const { page } = await h.session();

  await boot(page, pathUrl(`/pages/page/${pageId}`), {
    marker: "[data-block-id]",
    settleMs: SETTLE_MS,
  });

  const headings = await renderedHeadings(page);
  r.ok(
    "the page renders at least two headings",
    headings.length >= 2,
    `found ${headings.length} — the rail hides itself below two, so pick a richer page via --page`,
  );
  if (headings.length < 2) return await r.finish();
  r.note(`${headings.length} headings rendered`);

  await openPanel(page);
  const entries = await panelEntries(page);

  // The independent oracle: the outline's entries must BE the page's heading
  // blocks, in document order. A heading identified by type name rather than by
  // declared semantics, or ordered by what is visible rather than by the
  // document, fails here before anything is clicked.
  const ids = entries.map((e) => e.id);
  const want = headings.map((hd) => hd.id);
  const firstMismatch = ids.findIndex((id, i) => id !== want[i]);
  r.ok(
    "every entry names a rendered heading, in document order",
    ids.length === want.length && firstMismatch === -1,
    ids.length !== want.length
      ? `the outline lists ${ids.length} headings but ${want.length} are rendered`
      : `entry ${firstMismatch + 1} names ${ids[firstMismatch]} but the page's ` +
          `${firstMismatch + 1}th heading is ${want[firstMismatch]}`,
  );

  // Depth has to reach the panel, or the outline of a structured page reads flat.
  const deeper = headings.findIndex(
    (hd, i) => i > 0 && hd.level > (headings[0]?.level ?? 1),
  );
  if (deeper > 0) {
    r.ok(
      "a deeper heading is indented further than a top-level one",
      (entries[deeper]?.indent ?? 0) > (entries[0]?.indent ?? 0),
      `h${headings[deeper]?.level} row indent ${entries[deeper]?.indent}px is not ` +
        `greater than the h${headings[0]?.level} row's ${entries[0]?.indent}px`,
    );
  } else {
    r.note(
      "no heading deeper than the first — depth not exercised on this page",
    );
  }

  // Probe first and last: a position indicator that only ever reports the top of
  // the document passes on the first and fails on the last.
  for (const i of [...new Set([0, entries.length - 1])]) {
    const entry = entries[i]!;
    const shown = entry.label.slice(0, 32);
    await openPanel(page);
    const button = await page.$(
      `${RAIL} [data-outline-row][data-outline-id="${attrValue(entry.id)}"]`,
    );
    if (!button) {
      r.ok(
        `entry ${i + 1} ("${shown}") is clickable`,
        false,
        `no panel row carries ${entry.id}`,
      );
      continue;
    }
    await button.click();
    await page.waitForTimeout(1200); // smooth scroll + the observer's callback

    r.ok(
      `entry ${i + 1} ("${shown}") becomes the current heading`,
      (await activeId(page)) === entry.id,
      (await activeId(page)) === null
        ? "no dash is marked active — the rail is a jump list, not a position indicator"
        : `the rail reports ${await activeId(page)} as current, not ${entry.id}`,
    );
  }

  return await r.finish();
});
