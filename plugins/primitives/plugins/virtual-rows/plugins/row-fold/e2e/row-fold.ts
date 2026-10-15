// Row-fold probe: toggles a disclosure twice — a tree row's Expand / Collapse
// button, or a DataView group header — and samples every line on the page,
// so a fold that jumps (no tween), stalls (a long frame swallows it) or
// slides the wrong rows shows up as numbers rather than a feeling.
//
// Usage:
//   ./singularity run plugins/primitives/plugins/virtual-rows/plugins/row-fold/e2e/row-fold.ts \
//     --path /agents/tasks --row "Design" [--settle 2000] [--window 2500] [--out /tmp/fold] [--headed]
//   ./singularity run …/row-fold.ts --path /agents/all-conversations --group-by Model --group "<model>"
//
// --row is a tree row's label, matched exactly (a text node of the row reads
// it whole). --group toggles the group header whose text starts with it;
// --group-by first groups the view by that field (View settings) and puts it
// back to None after. Works for any tree renderer (windowed or not, a nested table) and
// for a lazy node: lines are `[data-tree-id]` rows and `[data-tree-placeholder]`
// children (and any `[data-row-fold]` line), positions are viewport tops, and
// a line's visibility is its effective opacity (its own times
// every ancestor's) — whichever box the fold animates.
//
// Two clocks per click. The REAL clock samples every animation frame — the
// frame cadence (measured idle first), long tasks, what actually painted; a
// headless browser on a loaded machine paints a few frames a second, so a
// 200 ms tween there CAN only paint one or two. The TWEEN clock pauses every
// animation the click starts and scrubs it through its duration in 10 steps,
// sampling the lines at each — what a 60 fps display paints, independent of
// this machine. Exit 1 unless, on the tween clock, the lines that appeared or
// went pass through 3+ partial opacities and the first line below passes
// through 3+ offsets between its ends.

import type { Locator, Page } from "playwright";
import {
  arg,
  numArg,
  requireArg,
  requirePage,
  withBrowser,
  report,
  ELEMENT_TIMEOUT_MS,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const USAGE =
  "--path /agents/tasks (--row <label> | --group <label> [--group-by <field>])";
const url = requirePage(USAGE);
const rowLabel = arg("row");
const groupLabel = arg("group");
const groupBy = arg("group-by");
const label = rowLabel ?? groupLabel ?? requireArg("row", USAGE);
const settle = numArg("settle", 2000);
const windowMs = numArg("window", 2500);
const out = arg("out");

/** One frame: ms since the click, and per line [key, offset, opacity]. */
type Frame = [number, [string, number, number][]];

interface Trace {
  /** Sampled on the real clock, every animation frame. */
  frames: Frame[];
  /** Sampled on the tween's own clock: each fold's animations are paused as
   *  they start and scrubbed through their duration — what a 60 fps display
   *  would paint, whatever this machine's frame rate. */
  scrub: Frame[];
  longTasks: [number, number][];
}

interface Verdict {
  folding: string[];
  foldingIntermediate: number;
  moved: string | null;
  movedIntermediate: number;
  longestGapMs: number;
}

const r = report(`row fold: ${label}`);

/** The first button / radio / option named `name`, polled until it shows. */
async function clickable(page: Page, name: string | RegExp): Promise<Locator> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    for (const role of [
      "menuitemradio",
      "radio",
      "option",
      "button",
    ] as const) {
      const c = page.getByRole(role, { name, exact: typeof name === "string" });
      if ((await c.count()) > 0) return c.first();
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`nothing clickable named ${String(name)}`);
}

/** Group the active DataView by `field` (or `None`) through View settings. */
async function setGroupBy(page: Page, field: string): Promise<void> {
  await (await clickable(page, /^View settings/)).click();
  await (await clickable(page, field)).click();
  await page.keyboard.press("Escape");
}

/** The disclosure to toggle, and the element positions are measured from. */
async function findTrigger(
  page: Page,
): Promise<{ trigger: Locator; hover: Locator }> {
  if (groupLabel !== undefined) {
    // A group header: the section's own `aria-expanded` trigger.
    const header = page
      .locator("[aria-expanded]")
      .filter({ hasText: new RegExp(`^\\s*${groupLabel}`) })
      .first();
    try {
      await header.waitFor({ timeout: ELEMENT_TIMEOUT_MS });
    } catch (err) {
      const texts = await page.locator("[aria-expanded]").allInnerTexts();
      console.log(
        `no group header starts "${groupLabel}"; headers here: ${texts.map((t) => t.replace(/\s+/g, " ").trim().slice(0, 40)).join(" | ")}`,
      );
      throw err;
    }
    return { trigger: header, hover: header };
  }
  const treeRow = page
    .locator("[data-tree-row]")
    .filter({ has: page.getByText(label, { exact: true }) })
    .first();
  try {
    await treeRow.waitFor({ timeout: ELEMENT_TIMEOUT_MS });
  } catch (err) {
    // Name the rows there are, so a wrong --row is a one-step fix.
    const labels = await page
      .locator("[data-tree-row]")
      .evaluateAll((rows) =>
        rows.slice(0, 40).map((r) => (r.textContent ?? "").trim().slice(0, 40)),
      );
    console.log(
      `no tree row reads "${label}"; rows here: ${labels.join(" | ")}`,
    );
    throw err;
  }
  return {
    trigger: treeRow.getByRole("button", { name: /^(Expand|Collapse)$/ }),
    hover: treeRow,
  };
}

await withBrowser(async (h) => {
  const { page } = await h.session({});
  await page.goto(url, { waitUntil: "domcontentloaded" });
  if (groupBy !== undefined) {
    await page.waitForTimeout(settle);
    await setGroupBy(page, groupBy);
  }
  const { trigger: toggle, hover } = await findTrigger(page);
  await toggle.scrollIntoViewIfNeeded();
  await page.waitForTimeout(settle);

  const idle = await page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const gaps: number[] = [];
        const t0 = performance.now();
        let last = t0;
        const tick = (now: number) => {
          gaps.push(Math.round(now - last));
          last = now;
          if (now - t0 < 600) requestAnimationFrame(tick);
          else resolve(gaps.slice(1));
        };
        requestAnimationFrame(tick);
      }),
  );
  console.log(`idle frame gaps (ms): ${idle.join(" ")}`);
  const viewportHeight = await page.evaluate(() => window.innerHeight);

  async function clickAndTrace(): Promise<Trace> {
    await page.evaluate(
      ({ windowMs }) => {
        const w = window as unknown as { __fold: Trace };
        w.__fold = { frames: [], scrub: [], longTasks: [] };
        const t0 = performance.now();
        // Catch every tween the click starts, held at its start.
        const animate = Element.prototype.animate;
        const caught: Animation[] = [];
        Element.prototype.animate = function (this: Element, ...args) {
          const anim = animate.apply(this, args);
          const duration = Number(anim.effect?.getTiming().duration ?? 0);
          if (duration >= 100) {
            caught.push(anim);
            // After the caller's own setup (its start time) in this task.
            queueMicrotask(() => anim.pause());
          }
          return anim;
        };
        const lt = new PerformanceObserver((list) => {
          for (const e of list.getEntries())
            w.__fold.longTasks.push([
              Math.round(e.startTime - t0),
              Math.round(e.duration),
            ]);
        });
        lt.observe({ type: "longtask" });
        const opacity = (el: Element | null) => {
          let o = 1;
          for (; el; el = el.parentElement)
            o *= Number(getComputedStyle(el).opacity);
          return Math.round(o * 100) / 100;
        };
        const sample = () => {
          const lines = [
            ...document.querySelectorAll<HTMLElement>(
              "[data-tree-id], [data-tree-placeholder], [data-row-fold]",
            ),
          ]
            // A fold wrapper around a tree line is that line, sampled once.
            .filter(
              (el) =>
                el.dataset.rowFold === undefined ||
                el.dataset.treeId !== undefined ||
                el.querySelector("[data-tree-id], [data-tree-placeholder]") ===
                  null,
            )
            .map((el): [string, number, number] => [
              el.dataset.treeId ??
                (el.dataset.treePlaceholder !== undefined
                  ? `placeholder:${el.dataset.treePlaceholder}`
                  : `line:${el.dataset.rowFold}`),
              Math.round(el.getBoundingClientRect().top),
              opacity(el),
            ]);
          return lines;
        };
        const scrub = () => {
          // A tween its owner cancelled before this tick (a fold superseded
          // by the next) is gone: scrubbing it would bring it back.
          const group = caught.splice(0).filter((a) => a.playState !== "idle");
          if (group.length === 0) return;
          const duration = Math.max(
            ...group.map((a) => Number(a.effect!.getTiming().duration)),
          );
          for (let step = 0; step <= 10; step++) {
            for (const a of group) a.currentTime = (duration * step) / 10;
            w.__fold.scrub.push([Math.round((duration * step) / 10), sample()]);
          }
          for (const a of group) a.finish();
        };
        const tick = () => {
          w.__fold.frames.push([Math.round(performance.now() - t0), sample()]);
          scrub();
          if (performance.now() - t0 < windowMs) requestAnimationFrame(tick);
          else {
            lt.disconnect();
            Element.prototype.animate = animate;
          }
        };
        requestAnimationFrame(tick);
      },
      { windowMs },
    );
    // A merged disclosure shows its chevron (and takes clicks) on hover only.
    await hover.hover();
    await toggle.click();
    await page.waitForTimeout(windowMs + 300);
    return page.evaluate(() => (window as unknown as { __fold: Trace }).__fold);
  }

  function judge(name: string, { frames, scrub, longTasks }: Trace): Verdict {
    let longestGapMs = 0;
    for (let i = 1; i < frames.length; i++)
      longestGapMs = Math.max(longestGapMs, frames[i]![0] - frames[i - 1]![0]);
    const at = (f: Frame) => new Map(f[1].map(([k, y, o]) => [k, { y, o }]));
    const first = at(frames[0]!);
    const last = at(frames.at(-1)!);
    const seen = new Set<string>();
    for (const [, lines] of [...frames, ...scrub])
      for (const [k] of lines) seen.add(k);
    // Lines that appeared or went at some point (a lazy node's placeholder
    // comes and goes): the folding ones.
    const folding = [...seen].filter((k) => !first.has(k) || !last.has(k));
    // The first line on screen, present throughout, that ends elsewhere: the
    // line below the fold. (One pushed off screen is not drawn moving.)
    const onScreen = (y: number) => y >= 0 && y < viewportHeight;
    const moved =
      [...first.keys()].find(
        (k) =>
          last.has(k) &&
          last.get(k)!.y !== first.get(k)!.y &&
          (onScreen(first.get(k)!.y) || onScreen(last.get(k)!.y)),
      ) ?? null;
    const between = (trace: Frame[]) => {
      const opacities = new Set<number>();
      const offsets = new Set<number>();
      const ends =
        moved === null ? [] : [first.get(moved)!.y, last.get(moved)!.y];
      const lo = Math.min(...ends);
      const hi = Math.max(...ends);
      for (const [, lines] of trace)
        for (const [k, y, o] of lines) {
          if (folding.includes(k) && o > 0 && o < 1) opacities.add(o);
          if (k === moved && y > lo && y < hi) offsets.add(y);
        }
      return { opacities: opacities.size, offsets: offsets.size };
    };
    const real = between(frames);
    const tween = between(scrub);
    const series = (trace: Frame[], k: string, field: 1 | 2) =>
      trace
        .map(
          ([t, lines]) =>
            [t, lines.find(([key]) => key === k)?.[field] ?? "-"] as const,
        )
        .filter(
          (f, i, a) => i === 0 || f[1] !== a[i - 1]![1] || f[0] < a[i - 1]![0],
        )
        .map(([t, v]) => `${t}:${v}`)
        .join(" ");
    console.log(`${name}:`);
    console.log(
      `  real clock: ${frames.length} frames, longest gap ${longestGapMs}ms, ${real.opacities} intermediate opacities, ${real.offsets} intermediate offsets; long tasks ${longTasks.map(([t, d]) => `${t}+${d}`).join(" ") || "none"}`,
    );
    console.log(
      `  lines drawn per frame: ${frames
        .map(([t, lines]) => `${t}:${lines.length}`)
        .filter(
          (f, i, a) => i === 0 || f.split(":")[1] !== a[i - 1]!.split(":")[1],
        )
        .join(" ")}`,
    );
    console.log(
      `  tween clock (${scrub.length} scrubbed frames): ${tween.opacities} intermediate opacities, ${tween.offsets} intermediate offsets`,
    );
    for (const k of folding)
      console.log(`    ${k} opacity: ${series(scrub, k, 2)}`);
    if (moved !== null)
      console.log(`    ${moved} offset: ${series(scrub, moved, 1)}`);
    return {
      folding,
      foldingIntermediate: tween.opacities,
      moved,
      movedIntermediate: tween.offsets,
      longestGapMs,
    };
  }

  let one: Verdict;
  let two: Verdict;
  try {
    one = judge("first click", await clickAndTrace());
    await page.waitForTimeout(500);
    two = judge("second click", await clickAndTrace());
    if (out) await page.screenshot({ path: `${out}.png` });
  } finally {
    // Leave the view's config as it was found.
    if (groupBy !== undefined) await setGroupBy(page, "None");
  }
  for (const [name, v] of [
    ["first click", one],
    ["second click", two],
  ] as const) {
    r.ok(`${name}: some line folded`, v.folding.length > 0);
    r.ok(
      `${name}: folding lines fade through the tween`,
      v.foldingIntermediate >= 3,
    );
    r.ok(
      `${name}: the line below slides through the tween`,
      v.moved === null || v.movedIntermediate >= 3,
    );
  }
});
await r.finish();
