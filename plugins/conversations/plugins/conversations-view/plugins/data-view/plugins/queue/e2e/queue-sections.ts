/**
 * Verifies the Queue's user-made sections end to end, with real mouse drags:
 *
 * 1. Queue header "+" creates a section, its name field open → rename it.
 * 2. Drag a Queue row into the empty section (its "Empty" band): mid-drag the
 *    row is laid out there (counts follow) and follows the pointer; the drop
 *    files it (no snap-back).
 * 3. Drag it from there into Pinned between two rows: Pinned's rows slide;
 *    the drop lands it there. Then back onto the section's header (anchorless).
 * 4. Drag a Queue row onto the floating "New section" target: the target
 *    shifts no row when it appears, the list does not auto-scroll while the
 *    pointer travels onto it; the drop creates a section holding the row,
 *    name field open → rename it.
 * 4b. Drag a Queue row up across the section headers above it (cancelled):
 *    the dragged row stays at the same offset from the pointer every step —
 *    no jump while the pointer is on a header — and paints over every pinned
 *    header it passes under (topmost at its top edge and centre).
 * 5. Drag the second section's header above the first: sections reorder.
 * 6. Move to (row menu) → the other section.
 * 7. ⋯ → Delete each section: their rows go back to the Queue.
 *
 * Leaves the worktree's queue as it found it (sections deleted; the pinned
 * row moved back out of Pinned).
 *
 *   ./equin run plugins/conversations/plugins/conversations-view/plugins/data-view/plugins/queue/e2e/queue-sections.ts [--out <prefix>] [--headed]
 */
import type { Page } from "playwright";
import {
  arg,
  pathUrl,
  report,
  snap,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = arg("out") ?? "/tmp/queue-sections";
const HEADER = '[data-part="dv.group-header"]';
const NEW_GROUP = '[data-part="dv.new-group"]';
const A = "E2E Alpha";
const B = "E2E Beta";

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Every section header, in order: its label and count. */
async function headers(page: Page): Promise<string[]> {
  return page
    .locator(HEADER)
    .evaluateAll((els) =>
      els.map((el) =>
        (el as HTMLElement).innerText.replace(/\s+/g, " ").trim(),
      ),
    );
}

/** The rows of the section labelled `name`, in drawn order (titles). */
async function sectionRows(page: Page, name: string): Promise<string[]> {
  return page.evaluate(
    ({ name, header }) => {
      const hs = [...document.querySelectorAll<HTMLElement>(header)];
      const h = hs.find((el) => el.innerText.trim().startsWith(name));
      if (!h) return [];
      // Document order, not geometry: the dragged row is translated to
      // wherever the pointer is.
      const next = hs[hs.indexOf(h) + 1];
      const seen: string[] = [];
      for (const r of document.querySelectorAll<HTMLElement>(
        "div[data-row-key]",
      )) {
        const after =
          h.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING;
        const before =
          !next ||
          next.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_PRECEDING;
        if (!after || !before) continue;
        const t = r.innerText.split("\n")[0] ?? "";
        if (seen.at(-1) !== t) seen.push(t);
      }
      return seen;
    },
    { name, header: HEADER },
  );
}

async function headerBox(page: Page, name: string): Promise<Box> {
  const h = page.locator(HEADER).filter({ hasText: name }).first();
  const b = await h.boundingBox();
  if (!b) throw new Error(`no header ${name}`);
  return b;
}

async function rowBox(page: Page, title: string): Promise<Box> {
  const b = await page
    .locator("div[data-row-key]")
    .filter({ hasText: title })
    .first()
    .boundingBox();
  if (!b) throw new Error(`no row ${title}`);
  return b;
}

/** Press on `from`, pass the 4 px activation, glide to `to` (still held). */
async function dragTo(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x, from.y + 6, { steps: 3 });
  await page.waitForTimeout(50);
  const steps = 25;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * i) / steps,
      from.y + 6 + ((to.y - from.y - 6) * i) / steps,
    );
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(250);
}

/**
 * Whether the dragged row (the translated `[data-row-key]` titled `title`)
 * is the topmost thing painted at its top edge and its centre, while its box
 * overlaps a group header's: `null` when it overlaps none, else the points
 * where something else is on top (empty = it paints over the header).
 */
async function coveredUnderHeader(
  page: Page,
  title: string,
): Promise<string[] | null> {
  return page.evaluate(
    ({ title, header }) => {
      const row = [
        ...document.querySelectorAll<HTMLElement>("div[data-row-key]"),
      ]
        .filter((r) => r.innerText.startsWith(title))
        .find((r) => r.style.transform.includes("translate"));
      if (!row) return ["no dragged row"];
      const rr = row.getBoundingClientRect();
      const under = [...document.querySelectorAll<HTMLElement>(header)].some(
        (h) => {
          const hr = h.getBoundingClientRect();
          return hr.bottom > rr.top && hr.top < rr.bottom;
        },
      );
      if (!under) return null;
      const x = rr.left + rr.width / 2;
      const bad: string[] = [];
      for (const [name, y] of [
        ["top edge", rr.top + 1],
        ["centre", rr.top + rr.height / 2],
      ] as const) {
        const hit = document.elementFromPoint(x, y);
        if (!hit || !row.contains(hit))
          bad.push(
            `${name}@${Math.round(y)}: ${hit?.closest("[data-part]")?.getAttribute("data-part") ?? hit?.tagName ?? "nothing"}`,
          );
      }
      return bad;
    },
    { title, header: HEADER },
  );
}

const centre = (b: Box) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

/** The scrollTop of the scroller holding the rows. */
async function listScrollTop(page: Page): Promise<number> {
  return page.evaluate(() => {
    let n = document.querySelector("div[data-row-key]")?.parentElement ?? null;
    while (n) {
      if (/(auto|scroll)/.test(getComputedStyle(n).overflowY))
        return n.scrollTop;
      n = n.parentElement;
    }
    throw new Error("no scroller around the rows");
  });
}

/** The vertical centre of the row titled `title` (the drag source wrapper). */
async function rowCentreY(page: Page, title: string): Promise<number> {
  const b = await rowBox(page, title);
  return b.y + b.height / 2;
}

/** Whether the row titled `title` is translated (follows the pointer). */
async function follows(page: Page, title: string): Promise<boolean> {
  return page.evaluate((title) => {
    const row = [...document.querySelectorAll<HTMLElement>("div[data-row-key]")]
      .filter((r) => r.innerText.startsWith(title))
      .find((r) => r.style.transform.includes("translate"));
    return row !== undefined;
  }, title);
}

async function createSectionFromQueueHeader(page: Page, name: string) {
  const q = await headerBox(page, "Queue");
  await page.mouse.move(q.x + 20, q.y + q.height / 2);
  await page
    .locator(HEADER)
    .filter({ hasText: "Queue" })
    .getByRole("button", { name: "New section" })
    .click();
  await renameOpenField(page, name);
}

async function renameOpenField(page: Page, name: string) {
  const field = page.getByLabel("Section name");
  await field.waitFor({ state: "visible", timeout: 10_000 });
  await field.fill(name);
  await field.press("Enter");
  await page
    .locator(HEADER)
    .filter({ hasText: name })
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
}

async function deleteSection(page: Page, name: string) {
  const h = page.locator(HEADER).filter({ hasText: name }).first();
  await h.hover();
  await h.getByRole("button", { name: `${name} options` }).click();
  await page.getByRole("menuitem", { name: /^Delete/ }).click();
  await h.waitFor({ state: "detached", timeout: 10_000 });
}

await withBrowser(async (h) => {
  const r = report("conversations queue — user sections");
  const { page, captured } = await h.session();
  await page.setViewportSize({ width: 1400, height: 1400 });
  await page.goto(pathUrl("agents"), { waitUntil: "domcontentloaded" });
  await page
    .locator(HEADER)
    .filter({ hasText: "Queue" })
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(1000);
  r.note(`headers: ${JSON.stringify(await headers(page))}`);

  // 1. Create + rename from the Queue header.
  await createSectionFromQueueHeader(page, A);
  r.ok(
    `"${A}" is drawn, empty, before the Queue`,
    (await headers(page)).some((t) => t.startsWith(`${A} 0`)),
    JSON.stringify(await headers(page)),
  );

  // 2. A Queue row into the empty section's band.
  const queued = await sectionRows(page, "Queue");
  const x = queued[0]!;
  const y = queued[1]!;
  const z = queued[2]!;
  r.note(`queue head: ${JSON.stringify([x, y, z])}`);
  // A's own band (another empty section may be drawn too).
  const aKey = await page
    .locator(HEADER)
    .filter({ hasText: A })
    .first()
    .evaluate((el) =>
      el.closest("[data-group-drop]")?.getAttribute("data-group-drop"),
    );
  if (!aKey) throw new Error(`no drop target around ${A}'s header`);
  const band = page
    .locator(`[data-group-drop="${aKey}"]`)
    .filter({ hasText: "Empty" });
  await dragTo(
    page,
    centre(await rowBox(page, x)),
    centre((await band.first().boundingBox())!),
  );
  await snap(page, OUT, "1-into-empty-section");
  r.ok(
    "mid-drag: the row is laid out in the section",
    (await sectionRows(page, A)).includes(x),
  );
  r.ok("mid-drag: the dragged row follows the pointer", await follows(page, x));
  await page.mouse.up();
  const filed = await waitFor(
    () => sectionRows(page, A),
    (rows) => rows.includes(x),
    { timeoutMs: 5000 },
  );
  r.ok(
    "the drop files it into the section",
    filed.ok,
    JSON.stringify(filed.value),
  );
  await page.waitForTimeout(1500);
  r.ok(
    "…and it holds (no snap-back)",
    (await sectionRows(page, A)).includes(x),
  );

  // 3. From the section into Pinned, between its first two rows.
  const pinned = await sectionRows(page, "Pinned");
  if (pinned.length >= 2) {
    const p1 = await rowBox(page, pinned[1]!);
    await dragTo(page, centre(await rowBox(page, x)), {
      x: p1.x + p1.width / 2,
      y: p1.y + 4,
    });
    await snap(page, OUT, "2-into-pinned");
    const mid = await sectionRows(page, "Pinned");
    r.ok(
      "mid-drag: Pinned holds the row (its rows slide around it)",
      mid.includes(x),
      JSON.stringify(mid),
    );
    r.ok(
      "mid-drag: the dragged row follows the pointer",
      await follows(page, x),
    );
    await page.mouse.up();
    const landed = await waitFor(
      () => sectionRows(page, "Pinned"),
      (rows) => rows.includes(x),
      { timeoutMs: 5000 },
    );
    r.ok("the drop pins it", landed.ok, JSON.stringify(landed.value));
    await page.waitForTimeout(1000);
    // Back onto the section's header: anchorless.
    await dragTo(
      page,
      centre(await rowBox(page, x)),
      centre(await headerBox(page, A)),
    );
    await snap(page, OUT, "3-onto-header");
    await page.mouse.up();
    const back = await waitFor(
      () => sectionRows(page, A),
      (rows) => rows.includes(x),
      { timeoutMs: 5000 },
    );
    r.ok(
      "a drop on the header files it there",
      back.ok,
      JSON.stringify(back.value),
    );
  } else {
    r.note("fewer than 2 pinned rows — skipping the Pinned leg");
  }

  // 4. Onto the floating "New section" target — and no layout shift for it.
  // Let the last drop's layout animation settle before measuring.
  await page.waitForTimeout(1500);
  const before = await page
    .locator("div[data-row-key]")
    .evaluateAll((els) =>
      els.slice(0, 30).map((e) => Math.round(e.getBoundingClientRect().top)),
    );
  const yb = await rowBox(page, y);
  await page.mouse.move(yb.x + yb.width / 2, yb.y + yb.height / 2);
  await page.mouse.down();
  await page.mouse.move(yb.x + yb.width / 2, yb.y + yb.height / 2 + 6, {
    steps: 3,
  });
  await page.waitForTimeout(200);
  const target = page.locator(NEW_GROUP);
  r.ok(
    "the New section target appears while a row drags",
    (await target.count()) === 1,
  );
  const during = await page
    .locator("div[data-row-key]")
    .evaluateAll((els) =>
      els.slice(0, 30).map((e) => Math.round(e.getBoundingClientRect().top)),
    );
  r.eq("…and moves no row (no layout shift)", during, before);
  const tb = (await target.boundingBox())!;
  const scrollBefore = await listScrollTop(page);
  const steps = 20;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(
      yb.x + yb.width / 2,
      yb.y +
        yb.height / 2 +
        6 +
        ((tb.y + tb.height / 2 - yb.y - yb.height / 2 - 6) * i) / steps,
    );
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(250);
  const scrollAfter = await listScrollTop(page);
  r.ok(
    "moving onto the target does not auto-scroll the list",
    Math.abs(scrollAfter - scrollBefore) <= 2,
    `scrollTop ${scrollBefore} → ${scrollAfter}`,
  );
  r.ok(
    "the target lights while the row is over it",
    (await target.getAttribute("data-over")) !== null,
  );
  await snap(page, OUT, "4-over-new-section");
  await page.mouse.up();
  await renameOpenField(page, B);
  r.ok(
    `"${B}" holds the row`,
    (await sectionRows(page, B)).includes(y),
    JSON.stringify(await sectionRows(page, B)),
  );

  // 4b. A Queue row dragged up across the headers above it follows the
  // pointer at a constant offset — no jump on a header. Cancelled (Escape).
  await page.waitForTimeout(1000);
  const w = (await sectionRows(page, "Queue"))[1]!;
  const wb = await rowBox(page, w);
  const wx = wb.x + wb.width / 2;
  const wy = wb.y + wb.height / 2;
  const top = (await headerBox(page, "Pinned")).y + 40;
  await page.mouse.move(wx, wy);
  await page.mouse.down();
  await page.mouse.move(wx, wy - 6, { steps: 3 });
  await page.waitForTimeout(100);
  const offsets: number[] = [];
  let underHeader = 0;
  const covered: string[] = [];
  let shotUnder = false;
  for (let py = wy - 6; py >= top; py -= 4) {
    await page.mouse.move(wx, py);
    // Two frames: the move's render, then its layout.
    await page.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
    offsets.push(Math.round((await rowCentreY(page, w)) - py));
    const bad = await coveredUnderHeader(page, w);
    if (bad !== null) {
      underHeader++;
      covered.push(...bad);
      if (!shotUnder) {
        shotUnder = true;
        await snap(page, OUT, "4b-under-header");
      }
    }
  }
  const spread = Math.max(...offsets) - Math.min(...offsets);
  await snap(page, OUT, "4b-across-headers");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  r.ok(
    "the dragged row stays under the pointer across section headers",
    spread <= 3,
    `offset spread ${spread}px over ${offsets.length} steps`,
  );
  r.ok(
    "the dragged row paints over every pinned header it passes under (topmost at its top edge)",
    underHeader > 0 && covered.length === 0,
    `${underHeader} steps under a header; covered: ${JSON.stringify(covered.slice(0, 6))}`,
  );

  // 5. Drag B's header above A's.
  const hb = await headerBox(page, B);
  const ha = await headerBox(page, A);
  await dragTo(
    page,
    { x: hb.x + 30, y: hb.y + hb.height / 2 },
    { x: ha.x + 30, y: ha.y + 2 },
  );
  await snap(page, OUT, "5-header-drag");
  await page.mouse.up();
  const reordered = await waitFor(
    () => headers(page),
    (hs) =>
      hs.findIndex((t) => t.startsWith(B)) <
      hs.findIndex((t) => t.startsWith(A)),
    { timeoutMs: 5000 },
  );
  r.ok(
    "dragging a header reorders the sections",
    reordered.ok,
    JSON.stringify(reordered.value),
  );

  // 6. Move to → A, from the row's menu.
  const zRow = page.locator("div[data-row-key]").filter({ hasText: z }).first();
  await zRow.hover();
  await zRow.getByRole("button", { name: "Move to…" }).click();
  await snap(page, OUT, "6-move-to-menu");
  await page.getByRole("menuitemcheckbox", { name: A }).click();
  const moved = await waitFor(
    () => sectionRows(page, A),
    (rows) => rows.includes(z),
    { timeoutMs: 5000 },
  );
  r.ok(
    "Move to files the row into the section",
    moved.ok,
    JSON.stringify(moved.value),
  );

  // 7. Delete both: their rows go back to the Queue.
  await deleteSection(page, A);
  await deleteSection(page, B);
  const home = await waitFor(
    () => sectionRows(page, "Queue"),
    (rows) => [x, y, z].every((t) => rows.includes(t)),
    { timeoutMs: 5000 },
  );
  r.ok(
    "deleting the sections sends their rows back to the Queue",
    home.ok,
    JSON.stringify(home.value),
  );
  await snap(page, OUT, "7-after-delete");

  r.ok(
    "no page errors",
    captured.pageErrors.length === 0,
    captured.pageErrors.join(" | "),
  );
  await r.finish();
});
