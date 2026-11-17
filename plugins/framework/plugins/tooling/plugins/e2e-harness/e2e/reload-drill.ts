/**
 * The reload drill: does a reload give back what the user was doing?
 *
 * `reloadDrill(page, { step })` runs a step (type into a field, expand a
 * section, select rows, scroll), records what the screen shows, reloads, waits
 * for the app to settle, records again, and diffs. The invariant it checks is
 * kept-state's: remount ≡ reload ≡ upgrade — a surface is a function of its
 * place, server data and kept state (`primitives/kept-state/CLAUDE.md`).
 *
 * What it records (`DrillSnapshot`), each item keyed by what names it on both
 * sides of a reload — its `data-kept-name`, else the element's build-stamped
 * source line (`data-source`), owner (`data-ui-owner`), or accessible name,
 * plus its position among elements with the same name:
 *
 * - the route (pathname and query);
 * - every text field's value (text-like `<input>`, `<textarea>`,
 *   `contenteditable`);
 * - every `aria-expanded`, `aria-selected`, `aria-checked` and
 *   `aria-pressed` state;
 * - every slider's and spin button's `aria-valuenow` (a playhead, a tempo);
 * - every scrolled element's offset;
 * - every `[data-kept]` marker's value — a surface with state the DOM does
 *   not show (a canvas, a playhead) publishes it this way for the drill
 *   (`data-kept="bar 12"`, named by `data-kept-name="sonata.playhead"`).
 *
 * A difference is something the reload lost or changed. A field that was
 * empty before is not compared (nothing to lose); everything else that was
 * there before must come back the same. A popup open before the reload is
 * closed after it by design (the policy never reloads while one is open), so a
 * flow that types into one reopens it in `restore`.
 */
import type { Page } from "playwright";
import { waitForScreenReady } from "@plugins/framework/plugins/tooling/plugins/e2e-harness/plugins/page-ready/core";

export type DrillItemKind =
  | "route"
  | "field"
  | "expanded"
  | "selected"
  | "checked"
  | "pressed"
  | "value"
  | "scroll"
  | "kept";

export interface DrillItem {
  kind: DrillItemKind;
  key: string;
  value: string;
}

export interface DrillSnapshot {
  items: DrillItem[];
}

export interface DrillDifference {
  kind: DrillItemKind;
  key: string;
  before: string;
  /** `null`: nothing with this key on the reloaded page. */
  after: string | null;
}

export interface ReloadDrillOptions {
  /** What the user does before the reload. */
  step: (page: Page) => Promise<void>;
  /**
   * After the reload settles and before the second record: bring back what is
   * closed by design (reopen the popover the step typed into).
   */
  restore?: (page: Page) => Promise<void>;
  /** Only record inside this selector (default: the whole page). */
  within?: string;
  /** Wait after the step and after the restore, for writes / restores to land (ms). Default 500. */
  settleMs?: number;
  /** Item kinds not to compare (a surface where one is not state, say). */
  ignore?: readonly DrillItemKind[];
}

export interface ReloadDrillResult {
  before: DrillSnapshot;
  after: DrillSnapshot;
  /** Everything the reload lost or changed: empty when it gave all back. */
  differences: DrillDifference[];
  /** How many items were compared (a drill that compared nothing proves nothing). */
  compared: number;
}

/** Record what the page shows: route, fields, disclosure/selection, scroll, markers. */
export async function recordDrillSnapshot(
  page: Page,
  within?: string,
): Promise<DrillSnapshot> {
  const items = await page.evaluate((scopeSelector: string | null) => {
    const out: { kind: string; key: string; value: string }[] = [];
    out.push({
      kind: "route",
      key: "route",
      value: location.pathname + location.search,
    });
    const scope: ParentNode =
      scopeSelector === null
        ? document
        : (document.querySelector(scopeSelector) ?? document);
    const counts = new Map<string, number>();
    const nameOf = (el: Element): string => {
      const kept = el.getAttribute("data-kept-name");
      if (kept) return `kept:${kept}`;
      const stamp =
        el.getAttribute("data-source") ??
        el.getAttribute("data-ui-owner") ??
        el.getAttribute("aria-label") ??
        el.getAttribute("name") ??
        el.getAttribute("placeholder") ??
        (el.textContent ?? "").trim().slice(0, 40);
      return `${el.tagName.toLowerCase()}[${stamp}]`;
    };
    const keyOf = (kind: string, el: Element): string => {
      const base = `${kind}:${nameOf(el)}`;
      const n = counts.get(base) ?? 0;
      counts.set(base, n + 1);
      return n === 0 ? base : `${base}#${n}`;
    };
    const TEXT_TYPES = new Set([
      "",
      "text",
      "search",
      "email",
      "url",
      "tel",
      "number",
    ]);
    for (const el of scope.querySelectorAll(
      "input, textarea, [contenteditable='true'], [contenteditable='']",
    )) {
      let value: string | null = null;
      if (el instanceof HTMLInputElement) {
        if (TEXT_TYPES.has(el.type)) value = el.value;
      } else if (el instanceof HTMLTextAreaElement) value = el.value;
      else value = (el as HTMLElement).innerText.trim();
      if (value !== null)
        out.push({ kind: "field", key: keyOf("field", el), value });
    }
    const ARIA: [string, string][] = [
      ["aria-expanded", "expanded"],
      ["aria-selected", "selected"],
      ["aria-checked", "checked"],
      ["aria-pressed", "pressed"],
    ];
    for (const [attr, kind] of ARIA) {
      for (const el of scope.querySelectorAll(`[${attr}]`)) {
        out.push({
          kind,
          key: keyOf(kind, el),
          value: el.getAttribute(attr) ?? "",
        });
      }
    }
    // A slider's or spin button's value (a playhead, a tempo, a zoom): the
    // position a control was left at, read off its ARIA value.
    for (const el of scope.querySelectorAll(
      "[role='slider'][aria-valuenow], [role='spinbutton'][aria-valuenow]",
    )) {
      out.push({
        kind: "value",
        key: keyOf("value", el),
        value: el.getAttribute("aria-valuenow") ?? "",
      });
    }
    for (const el of scope.querySelectorAll("*")) {
      if (el.scrollTop > 0 || el.scrollLeft > 0)
        out.push({
          kind: "scroll",
          key: keyOf("scroll", el),
          value: `${Math.round(el.scrollTop)},${Math.round(el.scrollLeft)}`,
        });
    }
    for (const el of scope.querySelectorAll("[data-kept]")) {
      out.push({
        kind: "kept",
        key: keyOf("kept", el),
        value: el.getAttribute("data-kept") ?? "",
      });
    }
    return out;
  }, within ?? null);
  return { items: items as DrillItem[] };
}

/** What `after` lost or changed of `before` (an empty field before is not compared). */
export function diffDrillSnapshots(
  before: DrillSnapshot,
  after: DrillSnapshot,
  ignore: readonly DrillItemKind[] = [],
): { differences: DrillDifference[]; compared: number } {
  const afterByKey = new Map(after.items.map((i) => [`${i.kind}|${i.key}`, i]));
  const differences: DrillDifference[] = [];
  let compared = 0;
  for (const item of before.items) {
    if (ignore.includes(item.kind)) continue;
    if (item.kind === "field" && item.value === "") continue;
    compared += 1;
    const other = afterByKey.get(`${item.kind}|${item.key}`);
    if (other?.value === item.value) continue;
    differences.push({
      kind: item.kind,
      key: item.key,
      before: item.value,
      after: other?.value ?? null,
    });
  }
  return { differences, compared };
}

/** Run the step, reload, and diff what the screen shows before and after. */
export async function reloadDrill(
  page: Page,
  opts: ReloadDrillOptions,
): Promise<ReloadDrillResult> {
  const settleMs = opts.settleMs ?? 500;
  await opts.step(page);
  await page.waitForTimeout(settleMs);
  const before = await recordDrillSnapshot(page, opts.within);
  await page.reload({ waitUntil: "domcontentloaded" });
  const ready = await waitForScreenReady(page);
  if (ready.kind === "blank")
    throw new Error(
      `reloadDrill: the reloaded page never painted (one flat colour after ${ready.waitedMs} ms)`,
    );
  if (opts.restore) await opts.restore(page);
  await page.waitForTimeout(settleMs);
  const after = await recordDrillSnapshot(page, opts.within);
  return { before, after, ...diffDrillSnapshots(before, after, opts.ignore) };
}

/** The drill's verdict for a transcript: what was compared, and every loss. */
export function reloadDrillText(result: ReloadDrillResult): string {
  const lines = [
    `reload drill: ${result.compared} item(s) compared, ${result.differences.length} lost or changed`,
  ];
  for (const d of result.differences)
    lines.push(
      `  ${d.kind.padEnd(8)} ${d.key}: ${JSON.stringify(d.before)} → ${d.after === null ? "(gone)" : JSON.stringify(d.after)}`,
    );
  return lines.join("\n");
}
