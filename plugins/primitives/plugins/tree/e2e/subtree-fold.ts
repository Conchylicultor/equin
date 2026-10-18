/**
 * Verifies the tree primitive's **per-row subtree fold** — the unfold/fold
 * button `RowChrome` now renders in every tree row's hover cluster, gated only
 * on `hasChildren`.
 *
 * ## Why a script and not `screenshot.ts --click`
 *
 * The action cluster is `opacity-0 pointer-events-none` until its row is
 * hovered, so a blind click lands on the row underneath and navigates to that
 * page instead. The hover IS part of the flow, so every interaction here goes
 * row → `hover()` → button. (Playwright calls an `opacity-0` element "visible",
 * so `waitFor({state:"visible"})` proves nothing about the reveal; the reveal is
 * asserted from computed opacity + pointer-events instead.)
 *
 * ## The claim that actually matters
 *
 * "It folds the whole subtree" is only interesting next to "it folds one
 * level" — a button that merely toggled the row would pass any test that just
 * counted the row's own chevron. So the script measures BOTH on the same row:
 * open it with its plain chevron (one level) and count the descendants that
 * appear, then open it with the fold button and count again. The fold must
 * reveal strictly more. A root is chosen by scanning for the first one where
 * that difference exists, rather than hard-coding a page title that another
 * machine's Pages tree will not have.
 *
 * The Pages sidebar is the reference surface: it is the tree that never had this
 * affordance, because it never wrote its own copy of it.
 *
 * Manual only. Run after `./singularity build`:
 *   ./singularity run plugins/primitives/plugins/tree/e2e/subtree-fold.ts \
 *     --url http://<worktree>.localhost:9000 [--headed]
 *
 * Pass `--url` explicitly: the harness derives its default from
 * `$SINGULARITY_WORKTREE`, which in an agent shell read `singularity` (main),
 * not the worktree this script is checked out in.
 */
import type { Locator, Page } from "playwright";
import {
  arg,
  boot,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = arg("out") ?? "/tmp/subtree-fold";

const EXPAND = "Expand subtree";
const COLLAPSE = "Collapse subtree";

interface RowInfo {
  label: string;
  /** Where the row's label starts, in px from the viewport's left — depth ×
   *  `--tree-indent` past its siblings', whichever renderer drew the row (a
   *  `TreeList` row pays its indent on the row box, a nested table's in its
   *  first cell) and however a theme splits it between the pill and the
   *  content. */
  pad: number;
  /** One indent level in px — the row's resolved `--tree-indent` (a theme's). */
  indent: number;
  /** The fold button's label, or null when the row renders none (a leaf). */
  fold: string | null;
}

/**
 * Every tree row currently painted, in paint order.
 *
 * A row's hover cluster mounts when its row is first reached
 * (`row-actions`), so the survey reaches every row first — a `pointerover`,
 * as a passing pointer would — and reads the fold once they have rendered.
 */
async function snapshot(page: Page): Promise<RowInfo[]> {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll(".group\\/tree-row")) {
      el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    }
  });
  await page.waitForTimeout(150);
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".group\\/tree-row")].map(
      (el) => {
        const label = (el.textContent ?? "").split("\n")[0]!.trim();
        // The label's own box: the first text node with content.
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let x = el.getBoundingClientRect().left;
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if ((n.textContent ?? "").trim() === "") continue;
          const range = document.createRange();
          range.selectNodeContents(n);
          x = range.getBoundingClientRect().left;
          break;
        }
        return {
          label,
          pad: Math.round(x),
          indent: parseFloat(
            getComputedStyle(el).getPropertyValue("--tree-indent"),
          ),
          fold:
            el
              .querySelector('button[aria-label$="subtree"]')
              ?.getAttribute("aria-label") ?? null,
        };
      },
    ),
  );
}

/**
 * The rows nested under `rows[i]`: everything after it that is indented deeper,
 * stopping at the first row back at (or above) its own depth. Indentation is the
 * only structural signal a flat row list carries.
 */
function descendants(rows: RowInfo[], i: number): RowInfo[] {
  const own = rows[i]!.pad;
  const out: RowInfo[] = [];
  for (let j = i + 1; j < rows.length && rows[j]!.pad > own; j++)
    out.push(rows[j]!);
  return out;
}

/** How many indent levels the deepest descendant sits below the row itself. */
const depthBelow = (rows: RowInfo[], i: number): number => {
  const kids = descendants(rows, i);
  if (kids.length === 0) return 0;
  return Math.round(
    (Math.max(...kids.map((k) => k.pad)) - rows[i]!.pad) / rows[i]!.indent,
  );
};

interface Reveal {
  opacity: number;
  pointerEvents: string;
}

/**
 * Is this control actually reachable, or only in the DOM?
 *
 * The fade lives on the cluster, not the button, and `pointer-events: none` is
 * what makes a hidden control not a click target — so both are read up the
 * ancestor chain, stopping at the row that owns the `group/row-actions` reveal.
 */
const reveal = (button: Locator): Promise<Reveal> =>
  button.evaluate((el) => {
    let opacity = 1;
    let pointerEvents = "auto";
    for (
      let n: HTMLElement | null = el as HTMLElement;
      n;
      n = n.parentElement
    ) {
      const style = getComputedStyle(n);
      opacity = Math.min(opacity, Number(style.opacity));
      if (style.pointerEvents === "none") pointerEvents = "none";
      if (String(n.className).includes("group/row-actions")) break;
    }
    return { opacity, pointerEvents };
  });

/**
 * The cluster's settled reveal state.
 *
 * The fade is a CSS transition, so a single read right after a pointer move
 * catches it mid-flight — and how long it takes depends on what React is doing
 * at that moment (folding a 32-row subtree away is not free). A fixed sleep
 * therefore reads either the wrong value or a value that only usually settles;
 * this polls for the steady state and reports whatever it last saw if the state
 * never arrives, so a genuine failure still prints the real number.
 */
async function settledReveal(button: Locator, want: 0 | 1): Promise<Reveal> {
  const deadline = Date.now() + 3_000;
  let last = await reveal(button);
  while (last.opacity !== want && Date.now() < deadline) {
    await button.page().waitForTimeout(100);
    last = await reveal(button);
  }
  return last;
}

/** Park the pointer somewhere no tree row can claim it. */
const unhover = (page: Page): Promise<void> => page.mouse.move(1200, 760);

await withBrowser(async (h) => {
  const r = report("tree primitive — per-row subtree fold");
  const { page, captured } = await h.session();

  const badResponses: string[] = [];
  page.on("response", (res) => {
    if (res.status() >= 400) {
      badResponses.push(`${res.status()} ${res.url()}`);
    }
  });

  await boot(page, pathUrl("/pages"), {
    marker: ".group\\/tree-row",
    settleMs: 800,
  });
  await snap(page, OUT, "before");

  const rows = page.locator(".group\\/tree-row");
  const roots = await snapshot(page);
  r.note(
    `root rows: ${JSON.stringify(roots.map((x) => `${x.label}:${x.fold ?? "-"}`))}`,
  );
  r.ok("the sidebar tree painted rows", roots.length > 0);
  r.ok(
    "every row starts collapsed (the survey below assumes it)",
    roots.every((x) => x.pad === roots[0]!.pad),
    JSON.stringify(roots.map((x) => x.pad)),
  );

  // --- The gate: a parent has the button, a leaf does not --------------------
  const parents = roots.filter((x) => x.fold !== null);
  const leaves = roots.filter((x) => x.fold === null);
  r.ok("at least one row offers the fold", parents.length > 0);
  r.ok(
    "at least one row offers none (the `hasChildren` gate does something)",
    leaves.length > 0,
    `every root row rendered a fold button: ${JSON.stringify(roots.map((x) => x.label))}`,
  );
  r.ok(
    "a collapsed row's fold reads 'Expand subtree'",
    parents.every((x) => x.fold === EXPAND),
    JSON.stringify(parents.map((x) => x.fold)),
  );

  // The gate is only correct if "no button" really means "no children": a
  // row without the fold offers no chevron either (the disclosure draws one
  // only for a row with children).
  const leafIndex = roots.findIndex((x) => x.fold === null);
  if (leafIndex < 0) {
    r.fail("no leaf row to check", "cannot prove the gate is not always-on");
  } else {
    const leafRow = rows.nth(leafIndex);
    await leafRow.hover();
    r.eq(
      `"${roots[leafIndex]!.label}" is genuinely childless — it offers no chevron`,
      await leafRow
        .getByRole("button", { name: "Expand", exact: true })
        .count(),
      0,
    );
  }

  // --- Survey: find a root whose subtree is deeper than one level ------------
  // Measured per root, always restoring the collapsed state, so the row indices
  // in `roots` stay valid throughout.
  interface Probe {
    index: number;
    label: string;
    /** Descendants revealed by the plain chevron — one level. */
    chevron: number;
    /** Descendants revealed by the fold button — the whole subtree. */
    subtree: number;
    /** Indent levels the fold reached. */
    depth: number;
  }
  let chosen: Probe | undefined;
  const probes: Probe[] = [];

  for (let i = 0; i < roots.length && !chosen; i++) {
    if (roots[i]!.fold === null) continue;
    const row = rows.nth(i);

    await row.hover();
    await row.getByRole("button", { name: "Expand", exact: true }).click();
    await page.waitForTimeout(300);
    const chevron = descendants(await snapshot(page), i).length;
    await row.hover();
    await row.getByRole("button", { name: "Collapse", exact: true }).click();
    await page.waitForTimeout(300);

    await row.hover();
    await row.getByRole("button", { name: EXPAND, exact: true }).click();
    await page.waitForTimeout(400);
    const opened = await snapshot(page);
    const probe: Probe = {
      index: i,
      label: roots[i]!.label,
      chevron,
      subtree: descendants(opened, i).length,
      depth: depthBelow(opened, i),
    };
    probes.push(probe);
    r.note(
      `"${probe.label}": chevron reveals ${probe.chevron}, fold reveals ${probe.subtree} (${probe.depth} levels)`,
    );
    if (probe.subtree > probe.chevron) chosen = probe;

    await row.hover();
    await row.getByRole("button", { name: COLLAPSE, exact: true }).click();
    await page.waitForTimeout(300);
  }

  if (!chosen) {
    r.fail(
      "no root has a subtree deeper than one level",
      `cannot tell a whole-subtree fold from a one-level toggle with this data: ${JSON.stringify(probes)}`,
    );
    await r.finish();
  }

  // --- The behaviour, on the row the survey chose ----------------------------
  const target = chosen!;
  const row = rows.nth(target.index);
  r.note(`asserting on "${target.label}"`);

  // Hidden at rest — not merely styled dim: `pointer-events: none` is what stops
  // a blind click from landing on the row and navigating away.
  await unhover(page);
  const atRest = await settledReveal(
    row.getByRole("button", { name: EXPAND, exact: true }),
    0,
  );
  r.eq("the fold is invisible until its row is hovered", atRest.opacity, 0);
  r.eq("and is not a click target while hidden", atRest.pointerEvents, "none");

  await row.hover();
  const hovered = await settledReveal(
    row.getByRole("button", { name: EXPAND, exact: true }),
    1,
  );
  r.eq("hovering the row reveals it", hovered.opacity, 1);
  r.eq("and makes it clickable", hovered.pointerEvents, "auto");

  await row.getByRole("button", { name: EXPAND, exact: true }).click();
  await page.waitForTimeout(400);
  await snap(page, OUT, "expanded");
  const opened = await snapshot(page);

  r.eq(
    "one click opens the whole subtree, not one level",
    descendants(opened, target.index).length > target.chevron,
    true,
  );
  r.note(
    `fold ${descendants(opened, target.index).length} vs chevron ${target.chevron} descendants`,
  );
  r.ok(
    `the subtree opened ${target.depth} levels deep, not 1`,
    target.depth >= 2,
    `depth ${target.depth}`,
  );
  r.eq(
    "the row's label flips to the collapse spelling",
    opened[target.index]!.fold,
    COLLAPSE,
  );

  await row.hover();
  await row.getByRole("button", { name: COLLAPSE, exact: true }).click();
  await page.waitForTimeout(400);
  const closed = await snapshot(page);
  r.eq(
    "clicking again folds the subtree away",
    descendants(closed, target.index).length,
    0,
  );
  r.eq(
    "and the label flips back to the expand spelling",
    closed[target.index]!.fold,
    EXPAND,
  );
  r.eq("the tree is back where it started", closed.length, roots.length);
  await snap(page, OUT, "after");

  r.ok(
    "no failing requests (the duress-shed log beacon excluded)",
    badResponses.length === 0,
    [...new Set(badResponses)].join("\n"),
  );
  const errors = [
    ...captured.pageErrors,
    // The console echo of a network response, already covered above.
    ...captured.consoleErrors.filter((e) => !/Failed to load resource/.test(e)),
  ];
  r.ok("no page or console errors", errors.length === 0, errors.join("\n"));
  await r.finish();
});
