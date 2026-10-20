/**
 * Verifies each outline entry navigates to the message it names, and that the
 * rail then reports that message as the one you are reading.
 *
 * The navigation half regressed silently for a long time: entries carried the
 * index into the *unfiltered* event array while the DOM stamps its positional
 * attribute over the *filtered* one, so any conversation where an `EventFilter`
 * hid an earlier row (`ask-user-question` hides `user-text` — exactly the kind
 * listed here) sent every entry to the wrong message. Counting entries, or
 * asserting that *a* row was reached, both pass with that bug live. Entries now
 * carry the event's own key, so the test can compare identities directly.
 *
 *   ./singularity run plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/outline/e2e/toc-lands-on-right-message.ts --conv <id>
 */
import {
  arg,
  boot,
  pathUrl,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { Page } from "playwright";

// The rail's published DOM contract (documented in the rail's own CLAUDE.md):
// the `<nav>` root expands on hover/focus, each panel row and each dash carries
// the entry id it stands for — for this consumer, the transcript row's own
// `data-event-key` — and the current dash says so. Pinned to the `label` this
// plugin passes, so another surface's rail on screen is never the one read.
const RAIL = '[data-outline-rail][aria-label="Conversation outline"]';
const ROW = `${RAIL} [data-outline-row]`;
const ACTIVE_DASH = `${RAIL} [data-outline-dash][data-active="true"]`;
const FOOTER = `${RAIL} [aria-label="Scroll to bottom"]`;
const SETTLE_MS = 2500;

const convId = arg("conv") ?? "conv-1785419906-z31p";

/**
 * How far a specific row sits from the top of the transcript viewport, in px.
 *
 * Asks about the *target* row rather than "which row is topmost". User messages
 * are wrapped in sticky section headers, so the previous section's header is
 * pinned at the top edge and a topmost-row query keeps naming the row before the
 * one that was actually revealed. Identity, not text, because every row's
 * `textContent` opens with its timestamp chip and the drag-and-drop
 * accessibility instructions from the reorderable action strip.
 */
async function userRowOffsets(
  page: Page,
): Promise<{ key: string; offset: number }[]> {
  return page.evaluate(() => {
    const scroller = [...document.querySelectorAll("[data-pane-scroll]")].find(
      (n) => n.querySelector("[data-event-key]"),
    ) as HTMLElement | undefined;
    if (!scroller) throw new Error("no transcript scroller");
    const viewTop = scroller.getBoundingClientRect().top;
    return [...scroller.querySelectorAll('[data-event-key^="user-text:"]')].map(
      (row) => ({
        key: row.getAttribute("data-event-key") ?? "",
        offset: row.getBoundingClientRect().top - viewTop,
      }),
    );
  });
}

/**
 * Where the target row ended up, as a fraction of the viewport height.
 * `null` when no row carries that key.
 *
 * Deliberately NOT "which user row is topmost": user messages are wrapped in
 * sticky section headers, so the current section's header is pinned at offset ≈ 0
 * forever and would answer that question no matter where the transcript is. The
 * target's own position cannot be spoofed that way. A fraction rather than px
 * because the last entry can't always reach the very top — there may not be
 * enough content below it to scroll against.
 */
/**
 * Escape a value for use inside a DOUBLE-QUOTED attribute selector, from Node.
 *
 * Not `CSS.escape`: that is a browser global, so it exists inside
 * `page.evaluate` (where this file also uses it) but is `undefined` in the
 * script's own scope. Only `\` and `"` can terminate a quoted attribute value,
 * so escaping those two is sufficient here — an event key (`user-text:<ts>`)
 * contains neither, but the selector should not depend on that.
 */
function attrValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function targetPosition(page: Page, key: string): Promise<number | null> {
  return page.evaluate((k) => {
    const scroller = [...document.querySelectorAll("[data-pane-scroll]")].find(
      (n) => n.querySelector("[data-event-key]"),
    ) as HTMLElement | undefined;
    if (!scroller) throw new Error("no transcript scroller");
    const row = scroller.querySelector(`[data-event-key="${CSS.escape(k)}"]`);
    if (!row) return null;
    const offset =
      row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    return offset / scroller.clientHeight;
  }, key);
}

/** The entries the panel lists, in order: each row's id and the text it shows. */
async function panelEntries(
  page: Page,
): Promise<{ id: string; label: string }[]> {
  return page.$$eval(ROW, (nodes) =>
    nodes.map((n) => ({
      id: n.getAttribute("data-outline-id") ?? "",
      label: n.textContent?.trim() ?? "",
    })),
  );
}

/**
 * The entry the rail currently calls "you are here", by id.
 *
 * Read off the dash, not the panel row: the dash is the at-rest indicator — the
 * only part visible without hovering — and it is what a reader actually uses to
 * tell where they are.
 */
async function activeDashId(page: Page): Promise<string | null> {
  const dash = await page.$(ACTIVE_DASH);
  if (!dash) return null;
  return dash.evaluate((n) => n.getAttribute("data-outline-id"));
}

/** Open the hover-revealed panel. Idempotent — safe to call before each click. */
async function openPanel(page: Page): Promise<void> {
  // The previous click moved the pointer away, so re-hover every time.
  await page.hover(RAIL);
  // The panel expands via a size transition; clicking mid-animation is silently
  // swallowed, which reads as "the entry navigated nowhere".
  await page.waitForSelector(ROW, { state: "visible" });
  await page.waitForTimeout(500);
}

/**
 * Wait until the smooth scroll stops moving.
 *
 * The lead-in matters: a smooth scroll does not begin in the same tick as the
 * click, so sampling immediately gives two identical readings and "it has
 * settled" is indistinguishable from "it has not started". That reads as a
 * failure on precisely the longest jump — the one most worth testing.
 */
async function settleScroll(page: Page): Promise<void> {
  await page.waitForTimeout(400);
  let previous = Number.NaN;
  let stable = 0;
  for (let i = 0; i < 40; i++) {
    const rows = await userRowOffsets(page);
    const current = rows[0]?.offset ?? 0;
    if (current === previous) {
      if (++stable >= 2) return;
    } else {
      stable = 0;
    }
    previous = current;
    await page.waitForTimeout(150);
  }
}

/** Every user message currently rendered, in DOM order. */
async function userRowKeys(page: Page): Promise<string[]> {
  return page.$$eval('[data-event-key^="user-text:"]', (nodes) =>
    nodes.map((n) => n.getAttribute("data-event-key") ?? ""),
  );
}

await withBrowser(async (h) => {
  const r = report("outline lands on the right message");
  const { page } = await h.session();

  await boot(page, pathUrl(`/agents/c/${convId}`), {
    marker: "[data-event-key]",
    settleMs: SETTLE_MS,
  });

  await openPanel(page);

  const entries = await panelEntries(page);
  r.ok(
    "the outline lists at least two user messages",
    entries.length >= 2,
    `found ${entries.length} outline entries — pick a conversation with more via --conv`,
  );
  r.note(`${entries.length} outline entries`);

  r.ok(
    "the scroll-to-bottom chevron is present",
    (await page.$(FOOTER)) !== null,
    "the footer this plugin passes to the rail is missing",
  );

  // The independent oracle, and the direct guard against the positional bug: the
  // ids the outline hands the rail must BE the keys the transcript stamped on its
  // rendered user rows, in the same order. An entry pointing one row off, or at a
  // row an EventFilter hid, fails here before anything is even clicked.
  //
  // A long conversation opens on its latest events, so the rendered rows are
  // the TAIL of the outline (older turns load as the reader scrolls up, or as
  // an entry is clicked): they must match its last entries, in order.
  const userRows = await userRowKeys(page);
  r.note(`${userRows.length} user-text rows rendered`);
  const ids = entries.map((e) => e.id);
  const tail = ids.slice(ids.length - userRows.length);
  const firstMismatch = tail.findIndex((id, i) => id !== userRows[i]);
  r.ok(
    "the rendered user messages are the outline's last entries, in order",
    userRows.length > 0 &&
      userRows.length <= ids.length &&
      firstMismatch === -1,
    userRows.length > ids.length
      ? `the outline lists ${ids.length} messages but ${userRows.length} user rows are rendered ` +
          `— the list and the transcript disagree about which events exist`
      : `entry ${ids.length - userRows.length + firstMismatch + 1} names ${tail[firstMismatch]} but the ` +
          `matching rendered user row is ${userRows[firstMismatch]}`,
  );

  // Check a spread of entries, not just the first: the off-by-filter bug grows
  // with distance from the top, so entry #1 can land correctly while later ones
  // do not.
  const probes = [
    ...new Set([0, Math.floor(entries.length / 2), entries.length - 1]),
  ];

  for (const i of probes) {
    const entry = entries[i]!;
    const shown = entry.label.slice(0, 32);
    await openPanel(page);
    // Addressed by id, never by index into a fresh query: the rail is free to
    // window what it renders, and a handle list taken twice is not the same list.
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
    // An entry older than the loaded window loads it first.
    await page
      .waitForSelector(`[data-event-key="${attrValue(entry.id)}"]`, {
        timeout: 30_000,
      })
      .catch((err: unknown) => {
        if (!(err instanceof Error && err.name === "TimeoutError")) throw err;
      });
    await settleScroll(page);

    const at = await targetPosition(page, entry.id);
    // Revealed = in the upper half of the viewport. Exactly 0 is unattainable
    // for the final entry, and precision is not what is under test — landing on
    // the right message is.
    const ok = at !== null && at >= -0.05 && at <= 0.5;
    r.ok(
      `entry ${i + 1} ("${shown}") reveals its own message`,
      ok,
      at === null
        ? `no row carries ${entry.id} — the entry points at nothing`
        : `${entry.id} ended up at ${(at * 100).toFixed(0)}% of the viewport height ` +
            `(0% = top); the click revealed a different message`,
    );

    // …and the rail agrees about where we now are. A jump list that lands
    // correctly but keeps its indicator somewhere else is the failure the dash
    // rail exists to remove, and the assertion above cannot see it.
    const active = await activeDashId(page);
    r.ok(
      `entry ${i + 1} ("${shown}") becomes the current dash`,
      active === entry.id,
      active === null
        ? "no dash is marked active — the rail is a jump list, not a position indicator"
        : `the rail marks ${active} as current after jumping to ${entry.id}`,
    );
  }

  return await r.finish();
});
