// Blocks another writer adds in ONE push arrive as one staged gesture, and
// never move the viewer's camera.
//
// The page is open (caret in an early line, scrolled down a little), then a
// batch is written into its middle through the page's op endpoint — the path
// an agent's edit takes, not this editor's own overlay: three to-dos each with
// a place under it, an empty line and a map. Per frame it records the
// scroller's scrollTop, the top of the line below the insertion, and every new
// row's opacity and its slot's height. Then one more to-do on its own.
//
// Asserts: scrollTop never changes; the content below moves monotonically to
// its full displacement with no frame jumping more than a fraction of it; the
// batch cascades in document order — each row's slot and content arriving
// together at its step, a place with its to-do, the empty line with no entry
// of its own, the map last — and each block is first SEEN (its slot open and
// its content showing) a step after the one above it; a lone block still
// eases in on one curve.
//
// With `--frames <dir>`, one more identical batch is written and held still:
// every animation paused and stepped through 0…1500 ms, one screenshot per
// 100 ms (`<dir>/batch-<ms>.png`) — to judge the cascade by eye.
//
// Usage: ./equin run plugins/page/plugins/editor/e2e/remote-batch-arrival-verify.ts [--frames <dir>]
import { mkdirSync } from "node:fs";
import {
  agentFetch,
  arg,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { Page } from "playwright";
import { blockIdOf, editableBlocks, openBlankPage } from "./support/blank-page";
import { typeLines } from "./support/type-lines";

const r = report();

const newId = () => `block-${crypto.randomUUID()}`;
const text = (t: string) => [{ text: t }];

interface Anim {
  name: string;
  delay: number;
  duration: number;
  easing: string;
  /** Start on the trace clock (ms since the trace began). */
  start: number;
}

interface Frame {
  t: number;
  scrollTop: number;
  below: number;
  opacity: Record<string, number>;
  /** The row's slot (its Arrival wrapper) height. */
  slot: Record<string, number>;
}

function place(name: string, lat: number, lng: number) {
  return {
    id: newId(),
    type: "place",
    data: {
      providerId: "google",
      placeId: `test-${name}`,
      name,
      address: `${name} street, Paris`,
      category: "Clothing store",
      lat,
      lng,
      fetchedAt: Date.now(),
    },
    expanded: true,
    children: [],
  };
}

function toDo(label: string, child: ReturnType<typeof place>) {
  return {
    id: newId(),
    type: "to-do",
    data: { text: text(label), checked: false },
    expanded: true,
    children: [child],
  };
}

/** One push: three to-dos with their places, an empty line, a map. */
function shopsBatch() {
  const shops = [
    toDo("Shop one", place("Atelier One", 48.86, 2.35)),
    toDo("Shop two", place("Atelier Two", 48.861, 2.34)),
    toDo("Shop three", place("Atelier Three", 48.858, 2.36)),
  ];
  const blank = {
    id: newId(),
    type: "text",
    data: { text: [] },
    expanded: true,
    children: [],
  };
  const map = {
    id: newId(),
    type: "map",
    data: {},
    expanded: true,
    children: [],
  };
  return { shops, blank, map, forest: [...shops, blank, map] };
}

async function writeOp(pageId: string, op: unknown): Promise<void> {
  const res = await agentFetch(`/api/pages/${pageId}/blocks/op`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(op),
  });
  if (!res.ok) throw new Error(`op failed: ${res.status} ${await res.text()}`);
}

/** Start recording frames in the page; `ids` are the rows to watch. */
async function startTrace(
  page: Page,
  belowId: string,
  ids: string[],
): Promise<void> {
  await page.evaluate(
    ({ belowId, ids }) => {
      const list = document.querySelector('[aria-label="Page blocks"]')!;
      let scroller: HTMLElement | null = list.parentElement;
      while (
        scroller &&
        !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)
      )
        scroller = scroller.parentElement;
      if (!scroller) throw new Error("no scroller");
      const frames: unknown[] = [];
      const anims: Record<string, unknown[]> = {};
      const t0 = performance.now();
      // The element whose opacity a row's entry animates: the child of the
      // Arrival wrapper (the RowCell's first child) holding the row.
      const entryOf = (id: string): Element | null => {
        const row = document.querySelector(`[data-block-id="${id}"]`);
        let el: Element | null = row;
        while (
          el &&
          el.parentElement &&
          !el.parentElement.parentElement?.style.gridRow
        )
          el = el.parentElement;
        return el;
      };
      const tick = () => {
        const below = document.querySelector(`[data-block-id="${belowId}"]`)!;
        const opacity: Record<string, number> = {};
        const slot: Record<string, number> = {};
        for (const id of ids) {
          const el = entryOf(id);
          if (!el) continue;
          opacity[id] = Number(getComputedStyle(el).opacity);
          slot[id] = el.parentElement?.getBoundingClientRect().height ?? 0;
          if (anims[id]) continue;
          // The row's own entry and its slot's opening, as the page runs them.
          const running = [
            ...el.getAnimations(),
            ...(el.parentElement?.getAnimations() ?? []),
          ].filter((a): a is CSSAnimation => a instanceof CSSAnimation);
          if (running.some((a) => a.startTime === null)) continue;
          anims[id] = running.map((a) => {
            const timing = a.effect!.getTiming();
            return {
              name: a.animationName,
              delay: Number(timing.delay),
              duration: Number(timing.duration),
              easing: String(timing.easing),
              // document.timeline shares performance.now()'s origin.
              start: Number(a.startTime) - t0,
            };
          });
        }
        frames.push({
          t: performance.now() - t0,
          scrollTop: scroller.scrollTop,
          below: below.getBoundingClientRect().top,
          opacity,
          slot,
        });
        if (performance.now() - t0 < 2500) requestAnimationFrame(tick);
        else
          (window as unknown as { __frames: unknown }).__frames = {
            frames,
            anims,
          };
      };
      requestAnimationFrame(tick);
    },
    { belowId, ids },
  );
}

interface Trace {
  frames: Frame[];
  anims: Record<string, Anim[]>;
}

async function readTrace(page: Page): Promise<Trace> {
  await page.waitForFunction(() => "__frames" in window, null, {
    timeout: 10_000,
  });
  return page.evaluate(() => {
    const w = window as unknown as { __frames?: Trace };
    const f = w.__frames!;
    delete w.__frames;
    return f;
  });
}

/** CSS cubic-bezier(x1,y1,x2,y2) as y(x). */
function bezier(x1: number, y1: number, x2: number, y2: number) {
  const c = (a: number, b: number, t: number) =>
    ((1 - 3 * b + 3 * a) * t + (3 * b - 6 * a)) * t * t + 3 * a * t;
  return (x: number) => {
    let lo = 0;
    let hi = 1;
    let t = x;
    for (let i = 0; i < 30; i++) {
      t = (lo + hi) / 2;
      if (c(x1, x2, t) < x) lo = t;
      else hi = t;
    }
    return c(y1, y2, t);
  };
}
const CALM = bezier(0.45, 0, 0.55, 1);

function checkCamera(label: string, frames: Frame[]): void {
  const tops = new Set(frames.map((f) => f.scrollTop));
  r.eq(`${label}: scrollTop never changes`, [...tops], [frames[0]!.scrollTop]);
}

/**
 * The content below moves monotonically, and on every frame sits where the
 * rows' own openings put it: Σ (row's final height × its ease at t) — so the
 * push is exactly the overlapping openings, whatever the frame rate.
 */
function checkPush(
  label: string,
  frames: Frame[],
  rows: { open: Anim | undefined; height: number }[],
): number {
  const start = frames[0]!.below;
  const end = frames.at(-1)!.below;
  const total = end - start;
  let monotonic = true;
  let moveStart: number | null = null;
  let moveEnd = 0;
  for (let i = 1; i < frames.length; i++) {
    const d = frames[i]!.below - frames[i - 1]!.below;
    if (d < -0.5) monotonic = false;
    if (Math.abs(d) > 0.5) {
      moveStart ??= frames[i - 1]!.t;
      moveEnd = frames[i]!.t;
    }
  }
  r.ok(`${label}: the content below moves down`, total > 0, `moved ${total}px`);
  r.ok(`${label}: monotonically`, monotonic);
  const known = rows.every((x) => x.open !== undefined);
  r.ok(`${label}: every row's opening was traced`, known);
  if (known) {
    let worst = 0;
    for (const f of frames) {
      let want = 0;
      for (const { open, height } of rows) {
        const u = Math.min(
          1,
          Math.max(0, (f.t - open!.start - open!.delay) / open!.duration),
        );
        want += height * CALM(u);
      }
      worst = Math.max(worst, Math.abs(f.below - start - want));
    }
    r.ok(
      `${label}: the content below follows the rows' own openings`,
      worst <= total * 0.08 + 2,
      `worst deviation ${worst.toFixed(1)}px of ${total.toFixed(1)}px`,
    );
  }
  r.note(
    `${label}: push ${total.toFixed(0)}px over ${moveStart === null ? "?" : (moveEnd - moveStart).toFixed(0)}ms`,
  );
  const samples = frames
    .filter((_, i) => i % 3 === 0)
    .slice(0, 30)
    .map((f) => `${f.t.toFixed(0)}:${(f.below - start).toFixed(0)}`);
  r.note(`${label}: below(t) ${samples.join(" ")}`);
  return total;
}

function everHidden(frames: Frame[], id: string): boolean {
  return frames.some(
    (f) => f.opacity[id] !== undefined && f.opacity[id]! < 0.95,
  );
}

await withBrowser(async (h) => {
  const { page } = await h.session();
  const doc = await openBlankPage(page, { settleMs: 2000 });
  const lines = Array.from(
    { length: 30 },
    (_, i) => `line ${String(i).padStart(2, "0")}`,
  );
  await typeLines(page, lines);
  await page.waitForTimeout(2500); // the doc -> row projection, and every row confirmed

  const blocks = editableBlocks(page);
  const ids = await Promise.all(lines.map((_, i) => blockIdOf(blocks.nth(i))));
  // The viewer: caret in an early line, the page scrolled a little.
  await blocks.nth(2).click();
  await page.evaluate(() => {
    const list = document.querySelector('[aria-label="Page blocks"]')!;
    let s: HTMLElement | null = list.parentElement;
    while (s && !/(auto|scroll)/.test(getComputedStyle(s).overflowY))
      s = s.parentElement;
    s!.scrollTop = 80;
  });
  await page.waitForTimeout(500);

  // ---- One push: three to-dos with their places, an empty line, a map --------
  const { shops, blank, map, forest } = shopsBatch();
  const watched = [
    ...shops.flatMap((s) => [s.id, s.children[0]!.id]),
    blank.id,
    map.id,
  ];
  await startTrace(page, ids[9]!, watched);
  await writeOp(doc.pageId, {
    kind: "paste",
    forest,
    afterId: ids[8]!,
    parentId: doc.pageId,
  });
  const { frames, anims } = await readTrace(page);
  const anim = (id: string, name: string) =>
    anims[id]?.find((a) => a.name === name);
  r.ok(
    "batch: every row arrived",
    watched.every((id) => frames.at(-1)!.opacity[id] === 1),
  );
  checkCamera("batch", frames);
  // Each row's slot opens at its step, its content entering with it.
  const at = (id: string, name: string) => {
    const a = anim(id, name);
    return a ? a.start + a.delay : Number.NaN;
  };
  const t0 = Math.min(
    ...watched.map((id) => anim(id, "arrival-open")?.start ?? Infinity),
  );
  r.note(
    `batch: open / entry (delay+duration ms) ${watched
      .map((id) => {
        const o = anim(id, "arrival-open");
        const e = anim(id, "arrival-rise");
        return `${o ? `${o.delay}+${o.duration}` : "?"} / ${e ? `${e.delay}+${e.duration}` : "none"}`;
      })
      .join(", ")} (to-do, place ×3, blank, map)`,
  );
  checkPush(
    "batch",
    frames,
    watched.map((id) => ({
      open: anim(id, "arrival-open"),
      height: frames.at(-1)!.slot[id] ?? 0,
    })),
  );
  r.ok(
    "batch: each row's slot and content arrive together",
    [...shops.flatMap((s) => [s.id, s.children[0]!.id]), map.id].every(
      (id) => Math.abs(at(id, "arrival-open") - at(id, "arrival-rise")) < 1,
    ),
  );
  for (const s of shops)
    r.ok(
      `batch: "${(s.data.text[0] as { text: string }).text}"'s place arrives with it`,
      at(s.id, "arrival-open") === at(s.children[0]!.id, "arrival-open"),
    );
  const order = [shops[0]!, shops[1]!, shops[2]!, map];
  r.eq(
    "batch: the shops then the map arrive 0 / 150 / 300 / 450 ms after the push",
    order.map((b) => Math.round(at(b.id, "arrival-open") - t0)),
    [0, 150, 300, 450],
  );
  r.eq(
    "batch: the empty line opens with the shop before it",
    at(blank.id, "arrival-open"),
    at(shops[2]!.id, "arrival-open"),
  );
  r.eq(
    "batch: a shop opens and enters over 450 ms",
    [
      anim(shops[0]!.id, "arrival-open")?.duration,
      anim(shops[0]!.id, "arrival-rise")?.duration,
    ],
    [450, 450],
  );
  r.eq(
    "batch: the map (a large block) opens and enters over 600 ms",
    [
      anim(map.id, "arrival-open")?.duration,
      anim(map.id, "arrival-rise")?.duration,
    ],
    [600, 600],
  );
  // What the viewer sees: a block is first SEEN once its slot has opened a
  // little AND its content shows — never earlier because another row's slot
  // revealed it. Measured on the trace, per block.
  const seenAt = (id: string): number => {
    const f = frames.find(
      (f) => (f.slot[id] ?? 0) > 3 && (f.opacity[id] ?? 0) > 0.1,
    );
    return f ? f.t : Number.NaN;
  };
  const legibleAt = (id: string): number => {
    const full = frames.at(-1)!.slot[id] ?? 0;
    const f = frames.find(
      (f) => (f.slot[id] ?? 0) >= full * 0.6 && (f.opacity[id] ?? 0) >= 0.6,
    );
    return f ? f.t : Number.NaN;
  };
  const seen = order.map((b) => seenAt(b.id));
  const legible = order.map((b) => legibleAt(b.id));
  const traceT0 = frames[0]!.t;
  r.note(
    `batch: first seen ${seen.map((t) => (t - traceT0).toFixed(0)).join(" / ")} ms, legible ${legible.map((t) => (t - traceT0).toFixed(0)).join(" / ")} ms (shop 1-3, map; trace clock)`,
  );
  r.ok(
    "batch: each block is first seen at least 100 ms after the one above it",
    seen.every((t, i) => i === 0 || t - seen[i - 1]! >= 100),
  );
  r.ok(
    "batch: and is legible at least 100 ms after it",
    legible.every((t, i) => i === 0 || t - legible[i - 1]! >= 100),
  );
  r.ok(
    "batch: the empty line has no entry of its own",
    anim(blank.id, "arrival-rise") === undefined &&
      !everHidden(frames, blank.id),
  );
  r.ok(
    "batch: every shop and the map do enter (not drawn at rest)",
    [...shops.map((s) => s.id), map.id].every((id) => everHidden(frames, id)),
  );
  const focused = await page.evaluate(
    () =>
      document.activeElement
        ?.closest("[data-block-id]")
        ?.getAttribute("data-block-id") ?? null,
  );
  r.eq("batch: the viewer's caret stays where it was", focused, ids[2]);

  // ---- A lone block still eases in ---------------------------------------------
  await page.waitForTimeout(500);
  const lone = {
    id: newId(),
    type: "to-do",
    data: { text: text("Lone"), checked: false },
    expanded: true,
    children: [],
  };
  await startTrace(page, ids[9]!, [lone.id]);
  await writeOp(doc.pageId, {
    kind: "paste",
    forest: [lone],
    afterId: ids[8]!,
    parentId: doc.pageId,
  });
  const one = await readTrace(page);
  checkCamera("lone", one.frames);
  checkPush("lone", one.frames, [
    {
      open: one.anims[lone.id]?.find((a) => a.name === "arrival-open"),
      height: one.frames.at(-1)!.slot[lone.id] ?? 0,
    },
  ]);
  r.ok("lone: it enters (not drawn at rest)", everHidden(one.frames, lone.id));

  // ---- Held frames, to judge by eye ---------------------------------------------
  const framesDir = arg("frames");
  if (framesDir) {
    mkdirSync(framesDir, { recursive: true });
    await page.waitForTimeout(800);
    const next = shopsBatch();
    await writeOp(doc.pageId, {
      kind: "paste",
      forest: next.forest,
      afterId: ids[8]!,
      parentId: doc.pageId,
    });
    // Freeze the moment the batch mounts: every entry paused at its start.
    await page.waitForFunction(
      (id) => {
        if (!document.querySelector(`[data-block-id="${id}"]`)) return false;
        const anims = document
          .getAnimations()
          .filter((a) => a instanceof CSSAnimation);
        if (anims.length === 0) return false;
        for (const a of anims) a.pause();
        return true;
      },
      next.shops[0]!.id,
      { polling: "raf" },
    );
    for (let t = 0; t <= 1500; t += 100) {
      await page.evaluate((t) => {
        for (const a of document.getAnimations())
          if (a instanceof CSSAnimation) a.currentTime = t;
      }, t);
      await page.screenshot({
        path: `${framesDir}/batch-${String(t).padStart(4, "0")}.png`,
      });
    }
    await page.evaluate(() => {
      for (const a of document.getAnimations()) a.play();
    });
    r.note(`frames: ${framesDir}/batch-*.png (0…1500 ms, every 100 ms)`);
  }
});

await r.finish();
