// The shared toolkit of the film's capture shots: the capture context (page,
// manifest, out dir), opening a route cleanly, hiding the chrome the film does
// not show, taking a still, measuring an element's rect, and the stepped
// typing sequence of the Wish popover. Every helper fails loudly when its
// target is missing: a film cut around a missing asset is worse than no film.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import { pathUrl } from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { AssetManifest, Rect } from "@plugins/media/plugins/film/e2e";

export const W = 1280;
export const H = 720;
export const DPR = 2;

/** An element finder: a CSS selector, or a function evaluated in the page. */
export type Finder = string | (() => Element | null);

export interface Ctx {
  context: BrowserContext;
  page: Page;
  out: string;
  manifest: AssetManifest;
}

export function newManifest(): AssetManifest {
  return {
    dpr: DPR,
    width: W,
    height: H,
    stills: {},
    rects: {},
    sequences: {},
    strips: {},
    stripRects: {},
    audio: {},
  };
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/** CSS applied on every page: toasts, developer marks and the dev map watermark are not the film's. */
const NOISE_CSS = `
[data-sonner-toaster]{display:none!important}
[data-ui-owner^="DeveloperCorner"]{display:none!important}
[data-ui-owner^="DismissAllButton"]{display:none!important}
`;

export async function open(
  p: Page,
  path: string,
  opts: { settleMs?: number } = {},
): Promise<void> {
  await p.goto(pathUrl(path), { waitUntil: "load" });
  await p.waitForFunction(
    () =>
      document.title.includes(" — ") ||
      document.body.innerText.trim().length > 40,
    null,
    {
      timeout: 60_000,
    },
  );
  await p.addStyleTag({ content: NOISE_CSS });
  await p.waitForTimeout(opts.settleMs ?? 3000);
  await sweepNoise(p);
}

/** Hide fixed-position notices (slow-operation notifications, refused-write toasts) and the map's dev watermark. */
export async function sweepNoise(p: Page): Promise<void> {
  await p.evaluate(() => {
    const noise =
      /Slow operation detected|Dismiss all|read-only for agent sessions|Couldn.t save|Map ID isn.t a vector map/;
    for (const e of Array.from(
      document.querySelectorAll<HTMLElement>("body *"),
    )) {
      if (e.children.length > 6) continue;
      const t = e.textContent ?? "";
      if (t.length > 400 || !noise.test(t)) continue;
      // The map watermark is matched on its own text: a container merely holding it is the map.
      if (
        /Map ID/.test(t) &&
        !/Map ID/.test(
          Array.from(e.childNodes)
            .filter((n) => n.nodeType === 3)
            .map((n) => n.nodeValue)
            .join(""),
        )
      )
        continue;
      // The nearest fixed ancestor is the notice itself (a big fixed root is never nearest to a leaf notice).
      let n: HTMLElement | null = e;
      let fixed: HTMLElement | null = null;
      while (n && n !== document.body) {
        if (getComputedStyle(n).position === "fixed") {
          fixed = n;
          break;
        }
        n = n.parentElement;
      }
      let target = fixed ?? e;
      for (
        let i = 0;
        i < 3 &&
        !fixed &&
        target.parentElement &&
        (target.parentElement.textContent ?? "") ===
          (target.textContent ?? "") &&
        target.parentElement.getBoundingClientRect().width < 420 &&
        target.parentElement.getBoundingClientRect().height < 80;
        i++
      )
        target = target.parentElement;
      let r = target.getBoundingClientRect();
      if (r.width > 700 || r.height > 400) {
        target = e;
        for (
          let i = 0;
          i < 3 &&
          target.parentElement &&
          (target.parentElement.textContent ?? "") ===
            (target.textContent ?? "") &&
          target.parentElement.getBoundingClientRect().width < 420 &&
          target.parentElement.getBoundingClientRect().height < 80;
          i++
        )
          target = target.parentElement;
        r = target.getBoundingClientRect();
        if (r.width > 700 || r.height > 400) continue;
      }
      target.style.visibility = "hidden";
    }
  });
}

/** The global action bar: the fixed ancestor of its Pick UI element button. Marks it `data-film-bar`. */
export async function markBar(p: Page): Promise<void> {
  await p.evaluate(() => {
    const b = Array.from(document.querySelectorAll("button")).find(
      (x) => x.getAttribute("aria-label") === "Pick UI element",
    );
    if (!b)
      throw new Error(
        "global action bar: its Pick UI element button not found",
      );
    let e: HTMLElement | null = b;
    while (e && getComputedStyle(e).position !== "fixed") e = e.parentElement;
    if (!e) throw new Error("global action bar: no fixed ancestor");
    e.setAttribute("data-film-bar", "");
  });
}

export async function hideBar(p: Page, hide = true): Promise<void> {
  await markBar(p);
  await p.evaluate((hide) => {
    for (const e of Array.from(
      document.querySelectorAll<HTMLElement>("[data-film-bar]"),
    ))
      e.style.visibility = hide ? "hidden" : "";
  }, hide);
}

/** The bar's live status (health, unread count, update chip) is the machine's, not the film's. */
export async function hideBarStatus(p: Page): Promise<void> {
  await p.evaluate(() => {
    for (const b of Array.from(
      document.querySelectorAll<HTMLElement>("[data-film-bar] button"),
    )) {
      const l = b.getAttribute("aria-label") ?? "";
      if (
        /^(Notifications|Under duress|All systems|Health|Out of date|Server updated|Reload|Builds)/i.test(
          l,
        )
      )
        b.style.visibility = "hidden";
    }
  });
}

/** Click a button by aria-label or text even when its toolbar is collapsed (aria-hidden / offscreen). */
export async function domClick(p: Page, label: string): Promise<void> {
  await p.evaluate((label) => {
    const b = Array.from(document.querySelectorAll("button")).find(
      (x) =>
        x.getAttribute("aria-label") === label ||
        x.textContent?.trim() === label,
    );
    if (!b) throw new Error(`button "${label}" not found`);
    b.click();
  }, label);
}

function finderSource(
  f: Finder,
): { kind: "css"; src: string } | { kind: "fn"; src: string } {
  return typeof f === "string"
    ? { kind: "css", src: f }
    : { kind: "fn", src: f.toString() };
}

/** Measure a finder's element in CSS px of the viewport. Throws when nothing matches. */
export async function measure(p: Page, name: string, f: Finder): Promise<Rect> {
  const spec = finderSource(f);
  const r = await p.evaluate(
    ([s, name]) => {
      const spec = s as { kind: "css" | "fn"; src: string };
      const el =
        spec.kind === "css"
          ? document.querySelector(spec.src)
          : (new Function(`return (${spec.src})()`) as () => Element | null)();
      if (!el)
        throw new Error(
          `rect ${name}: target not found (${spec.src.slice(0, 120)})`,
        );
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    },
    [spec, name] as const,
  );
  if (r.width < 1 || r.height < 1)
    throw new Error(`rect ${name}: target has no size`);
  return r;
}

export async function rect(c: Ctx, name: string, f: Finder): Promise<Rect> {
  const r = await measure(c.page, name, f);
  c.manifest.rects[name] = r;
  return r;
}

function clamp(r: Rect, vw: number, vh: number): Rect {
  const x = Math.max(0, Math.floor(r.x));
  const y = Math.max(0, Math.floor(r.y));
  const right = Math.min(vw, Math.ceil(r.x + r.width));
  const bottom = Math.min(vh, Math.ceil(r.y + r.height));
  return { x, y, width: right - x, height: bottom - y };
}

export async function shot(
  c: Ctx,
  name: string,
  clip?: Rect,
  p: Page = c.page,
): Promise<void> {
  await sweepNoise(p);
  const vp = p.viewportSize()!;
  const file = `${name}.png`;
  const cl = clip ? clamp(clip, vp.width, vp.height) : undefined;
  await p.screenshot({
    path: join(c.out, file),
    type: "png",
    ...(cl ? { clip: cl } : {}),
  });
  c.manifest.stills[name] = {
    file,
    ...(cl ?? { x: 0, y: 0, width: vp.width, height: vp.height }),
  };
  console.log(`  ${name}`);
}

/** A frame of a sequence: written to the assets dir, returns its file name (not a still). */
export async function frame(
  c: Ctx,
  name: string,
  clip: Rect,
  p: Page = c.page,
): Promise<string> {
  await sweepNoise(p);
  const vp = p.viewportSize()!;
  const file = `${name}.png`;
  await p.screenshot({
    path: join(c.out, file),
    type: "png",
    clip: clamp(clip, vp.width, vp.height),
  });
  return file;
}

export async function park(p: Page, x = W - 3, y = H - 3): Promise<void> {
  await p.mouse.move(x, y);
  await p.waitForTimeout(250);
}

/** A leaf element by exact text, optionally climbing to the first ancestor at least `minH` tall and `minW` wide. */
export function byText(
  text: string,
  climb?: { minH: number; minW: number },
  region?: { minX?: number; maxX?: number; minY?: number },
): Finder {
  const src = JSON.stringify({ text, climb, region });
  return new Function(`return (() => {
    const a = ${src};
    const leaf = Array.from(document.querySelectorAll('*')).find(e => {
      if (e.children.length !== 0 || (e.textContent || '').trim() !== a.text) return false;
      const r = e.getBoundingClientRect();
      if (r.width < 1) return false;
      if (a.region) {
        if (a.region.minX !== undefined && r.x < a.region.minX) return false;
        if (a.region.maxX !== undefined && r.x > a.region.maxX) return false;
        if (a.region.minY !== undefined && r.y < a.region.minY) return false;
      }
      return true;
    });
    if (!leaf) return null;
    if (!a.climb) return leaf;
    let t = leaf;
    while (t && (t.getBoundingClientRect().height < a.climb.minH || t.getBoundingClientRect().width < a.climb.minW)) t = t.parentElement;
    return t;
  })`)() as () => Element | null;
}

/** The pane columns (`data-pane-id`) of the focused tab, left to right: visible, narrower than the surface unless alone. */
export async function panes(
  p: Page,
): Promise<Array<{ id: string; rect: Rect }>> {
  const all = await p.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-pane-id]")).map(
      (e) => {
        const b = e.getBoundingClientRect();
        return {
          id: e.getAttribute("data-pane-id")!,
          rect: { x: b.x, y: b.y, width: b.width, height: b.height },
        };
      },
    ),
  );
  const seen = new Set<string>();
  const vis = all.filter((a) => a.rect.width > 40 && a.rect.height > 200);
  const narrow = vis.filter((a) => a.rect.width < W - 4);
  const pick = (narrow.length ? narrow : vis).filter((a) => {
    const k = `${a.id}@${Math.round(a.rect.x)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return pick.sort((a, b) => a.rect.x - b.rect.x);
}

/** The Wish popover's finder: the fixed / sided ancestor of the last contenteditable. */
const POPOVER: Finder = () => {
  let e: Element | null =
    Array.from(document.querySelectorAll('[contenteditable="true"]')).at(-1) ??
    null;
  while (
    e &&
    !(
      getComputedStyle(e).position === "fixed" ||
      e.hasAttribute("data-side") ||
      e.getAttribute("role") === "dialog"
    )
  )
    e = e.parentElement;
  return e;
};

/**
 * Type `text` into the open Wish popover as a stepped sequence (about `steps`
 * frames), capturing the popover crop at each step. Registers rects
 * `<name>-popover`, `-create`, `-editor` and the sequence `<name>`.
 * `keepChip`: the editor already holds an element chip (the picker's); typing continues after it.
 */
export async function typeSequence(
  c: Ctx,
  name: string,
  text: string,
  keepChip: boolean,
  steps = 10,
): Promise<void> {
  const p = c.page;
  const editor = p.locator('[contenteditable="true"]').last();
  await editor.waitFor({ state: "visible", timeout: 10_000 });
  await editor.click();
  if (keepChip) await editor.press("ControlOrMeta+End");
  else {
    await editor.press("ControlOrMeta+a");
    for (let k = 0; k < 3; k++) await editor.press("Backspace");
  }
  await p.waitForTimeout(500);
  await hideBarStatus(p);
  const pop = await rect(c, `${name}-popover`, POPOVER);
  const clip = {
    x: pop.x - 10,
    y: pop.y - 10,
    width: pop.width + 20,
    height: pop.height + 20,
  };
  await rect(
    c,
    `${name}-create`,
    () =>
      Array.from(document.querySelectorAll("button")).find((b) =>
        /Create task/.test(b.textContent ?? ""),
      ) ?? null,
  );
  await rect(
    c,
    `${name}-editor`,
    () =>
      Array.from(document.querySelectorAll('[contenteditable="true"]')).at(
        -1,
      ) ?? null,
  );
  await sweepNoise(p);
  await park(p, W / 2, H - 3);
  const frames: string[] = [];
  const stepLen = Math.max(1, Math.ceil(text.length / steps));
  let typed = 0;
  for (;;) {
    frames.push(
      await frame(
        c,
        `${name}-t${String(frames.length).padStart(2, "0")}`,
        clip,
      ),
    );
    if (typed >= text.length) break;
    const next = Math.min(text.length, typed + stepLen);
    await editor.pressSequentially(text.slice(typed, next));
    typed = next;
    await p.waitForTimeout(120);
  }
  await shot(c, `${name}-typed`);
  c.manifest.sequences[name] = { frames, clip: clamp(clip, W, H), text };
  console.log(`  ${name}: ${frames.length} frames`);
  // Leave the shared draft empty for the next shot (and the user).
  await editor.press("ControlOrMeta+a");
  for (let k = 0; k < 3; k++) await editor.press("Backspace");
}
