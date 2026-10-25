// Part metrics: the numbers behind "does the app match the mockup?", part by
// part. The pixel diff says WHERE the two frames differ; this says by how much
// and in which property — a card title 13.5px/600 in the mock and 11.5px/500
// in the app is one table row, not a red smear.
//
// A mapping file kept with the app (`<app>/e2e/<proto>.parts.json`) names, per
// DataView part, the mock's CSS selector for it. The mock stays unconstrained
// (no attributes, no conventions); the real component carries
// `data-part="<part>"`, so its selector defaults to `[data-part~="<part>"]`.
// Part names are the closed vocabulary `DATA_VIEW_PARTS` (data-view core) plus
// the pane's two (`pane.header`, `pane.title`); an unknown name refuses the run.
//
// Both frames are measured in their own document, frame-relative: box, padding,
// gaps, type (size, weight, line-height, first family, tracking, case), radius,
// border, colours, shadow, opacity. Colours are compared as ΔE (the harness's
// `deltaE`), composited over black and over white so an alpha difference
// counts too.

import { readFileSync } from "node:fs";
import type { Frame, Page } from "playwright";
import { z } from "zod";
import {
  deltaE,
  usage,
  type Rgba,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { DATA_VIEW_PARTS } from "@plugins/primitives/plugins/data-view/core";
import type {
  OptionPicks,
  PrototypeOption,
} from "@plugins/apps/plugins/prototypes/plugins/files/core";

/** Every part name a mapping may use: DataView's closed set + the pane's two. */
export const KNOWN_PARTS: readonly string[] = [
  ...DATA_VIEW_PARTS,
  "pane.header",
  "pane.title",
];

// --- box-shadow normalisation ----------------------------------------------

/** Split on commas that are not inside parentheses. */
function splitTopLevel(css: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of css) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((l) => l.trim()).filter((l) => l !== "");
}

/** The alpha of the colour inside one shadow layer (1 when it carries none). */
function layerAlpha(layer: string): number {
  if (/\btransparent\b/.test(layer)) return 0;
  const fn = /[a-z-]+\(([^()]*)\)/i.exec(layer);
  if (!fn) return 1;
  const body = fn[1] ?? "";
  const slash = /\/\s*([\d.e+-]+)(%?)/.exec(body);
  if (slash) return Number(slash[1]) / (slash[2] ? 100 : 1);
  if (/^(rgba|hsla)/i.test(fn[0])) {
    const parts = body.split(",");
    if (parts.length === 4) return Number(parts[3]);
  }
  return 1;
}

/**
 * A computed box-shadow without its invisible layers: Tailwind emits
 * `rgba(0, 0, 0, 0) 0px 0px 0px 0px` placeholders (ring / inset ring / shadow
 * vars) before the real shadow, which a mock never writes. Layers whose colour
 * has alpha 0 are dropped; nothing left reads `none`.
 */
export function normalizeBoxShadow(css: string): string {
  const kept = splitTopLevel(css.replace(/\s+/g, " ").trim()).filter(
    (l) => l !== "none" && layerAlpha(l) > 0,
  );
  return kept.length === 0 ? "none" : kept.join(", ");
}

// --- properties ------------------------------------------------------------

/** How a property's two values are compared. */
type PropKind = "px" | "weight" | "opacity" | "color" | "text" | "lineHeight";

const PROP_KIND = {
  x: "px",
  y: "px",
  width: "px",
  height: "px",
  "padding-top": "px",
  "padding-right": "px",
  "padding-bottom": "px",
  "padding-left": "px",
  "row-gap": "px",
  "column-gap": "px",
  "font-size": "px",
  "font-weight": "weight",
  "line-height": "lineHeight",
  "font-family": "text",
  "letter-spacing": "px",
  "text-transform": "text",
  "border-radius": "px",
  "border-width": "px",
  "border-color": "color",
  color: "color",
  "background-color": "color",
  "box-shadow": "text",
  opacity: "opacity",
} as const satisfies Record<string, PropKind>;

export type MetricProp = keyof typeof PROP_KIND;
const PROPS = Object.keys(PROP_KIND) as MetricProp[];

/** Shorthands a mapping entry's `props` may use for a family of properties. */
const PROP_GROUPS = {
  box: ["x", "y", "width", "height"],
  padding: ["padding-top", "padding-right", "padding-bottom", "padding-left"],
  gap: ["row-gap", "column-gap"],
  type: [
    "font-size",
    "font-weight",
    "line-height",
    "font-family",
    "letter-spacing",
    "text-transform",
  ],
  border: ["border-radius", "border-width", "border-color"],
  paint: ["color", "background-color", "box-shadow", "opacity"],
} as const satisfies Record<string, readonly MetricProp[]>;

type PropGroup = keyof typeof PROP_GROUPS;
const PROP_WORDS = [...PROPS, ...(Object.keys(PROP_GROUPS) as PropGroup[])] as [
  string,
  ...string[],
];

function expandProps(words: readonly string[] | undefined): MetricProp[] {
  if (!words) return PROPS;
  const out = new Set<MetricProp>();
  for (const w of words) {
    if (w in PROP_GROUPS) {
      for (const p of PROP_GROUPS[w as PropGroup]) out.add(p);
    } else out.add(w as MetricProp);
  }
  return PROPS.filter((p) => out.has(p));
}

// --- tolerance -------------------------------------------------------------

export interface Tolerance {
  /** Lengths: box, padding, gaps, font size, line height, tracking, radius, border width. */
  px: number;
  /** Colours: ΔE, worst of the two composites (over black, over white). */
  de: number;
  /** Font weight, in weight units (0 = exact). */
  weight: number;
  /** Opacity, 0–1. */
  opacity: number;
}

export const DEFAULT_TOLERANCE: Tolerance = {
  px: 0.5,
  de: 3,
  weight: 0,
  opacity: 0.01,
};

/** `px=0.5,de=3,weight=0` → a full tolerance (unnamed keys keep their default). */
export function parseTolerance(raw: string | undefined): Tolerance {
  const tol = { ...DEFAULT_TOLERANCE };
  if (raw === undefined) return tol;
  for (const pair of raw.split(",")) {
    const [key, value, ...rest] = pair.split("=").map((s) => s.trim());
    const num = Number(value);
    if (
      !key ||
      value === undefined ||
      value === "" ||
      rest.length > 0 ||
      !Number.isFinite(num) ||
      num < 0
    ) {
      usage(
        `--metrics-tolerance expects <key>=<non-negative number>,… — got "${pair}"`,
      );
    }
    if (!(key in tol)) {
      usage(
        `--metrics-tolerance: unknown key "${key}" (keys: ${Object.keys(tol).join(", ")})`,
      );
    }
    tol[key as keyof Tolerance] = num;
  }
  return tol;
}

// --- the mapping file ------------------------------------------------------

const EntrySchema = z
  .object({
    /** The DataView (or pane) part this mock element is. */
    part: z.string().refine((p) => KNOWN_PARTS.includes(p), {
      message: `not a known part (DATA_VIEW_PARTS in data-view core, or pane.header / pane.title)`,
    }),
    /** CSS selector in the mock's document. */
    mock: z.string().min(1),
    /** CSS selector in the app's document; default `[data-part~="<part>"]`. */
    app: z.string().min(1).optional(),
    /** Which match to measure, on both sides (default 0). */
    nth: z.number().int().min(0).optional(),
    /** Which app match to measure, when it differs from `nth`. */
    appNth: z.number().int().min(0).optional(),
    /** Only measured when the mock's picks are these (`{ "layout": "list" }`). */
    when: z.record(z.string(), z.string()).optional(),
    /** Measure while hovered. */
    hover: z.boolean().optional(),
    /** Mock: hover the element's closest ancestor matching this, not the element. */
    hoverTarget: z.string().min(1).optional(),
    /** App: the same, as a selector or a part name. */
    appHoverTarget: z.string().min(1).optional(),
    /** Properties (or groups: box, padding, gap, type, border, paint); default all. */
    props: z.array(z.enum(PROP_WORDS)).min(1).optional(),
    /** Distinguishes two entries for one part in the table. */
    label: z.string().min(1).optional(),
    /** Free text for the reader of the mapping. */
    note: z.string().optional(),
  })
  .strict();

const SetupStepSchema = z
  .object({
    /** Only run under these mock picks (`{ "layout": "list" }`). */
    when: z.record(z.string(), z.string()).optional(),
    /** CSS selector, in the app's document; must match exactly one element. */
    click: z.string().min(1),
    note: z.string().optional(),
  })
  .strict();

const MappingSchema = z
  .object({
    proto: z.string(),
    /** Clicks made in the app before measuring and capturing, keyed by picks. */
    appSetup: z.array(SetupStepSchema).optional(),
    parts: z.array(EntrySchema).min(1),
  })
  .strict();

/** One app-side setup step that applies to this run's picks. */
export interface AppSetupStep {
  click: string;
  note?: string;
}

/** A mapping resolved for this run. */
export interface LoadedMapping {
  targets: MetricTarget[];
  appSetup: AppSetupStep[];
}

/** Every `when` name / value must be a declared option (and value). */
function whenProblems(
  at: string,
  when: Record<string, string> | undefined,
  options: readonly PrototypeOption[],
): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(when ?? {})) {
    const o = options.find((x) => x.name === name);
    if (!o) out.push(`${at}.when: the prototype declares no option "${name}"`);
    else if (o.kind === "choice" && !o.values.includes(value)) {
      out.push(
        `${at}.when: ${name}=${value} is not one of ${o.values.join(" | ")}`,
      );
    }
  }
  return out;
}

export type MappingEntry = z.infer<typeof EntrySchema>;

/** One entry, resolved for this run. */
export interface MetricTarget {
  key: string;
  part: string;
  props: MetricProp[];
  mock: SideTarget;
  app: SideTarget;
  hover: boolean;
}

interface SideTarget {
  selector: string;
  nth: number;
  /** Closest-ancestor selector to hover instead of the element; null = the element. */
  hoverTarget: string | null;
}

const partSelector = (part: string): string => `[data-part~="${part}"]`;

function entryKey(e: MappingEntry): string {
  if (e.label) return e.label;
  return `${e.part}${e.nth ? `[${e.nth}]` : ""}${e.hover ? ":hover" : ""}`;
}

/**
 * Read and validate a mapping file against this run: the prototype it names,
 * the options its `when` filters use (declared names and values only), and
 * unique row keys. Returns the entries whose `when` matches the effective picks
 * (`--options` over the page's defaults).
 */
export function loadMapping(
  path: string,
  proto: string,
  options: readonly PrototypeOption[],
  picks: OptionPicks,
): LoadedMapping {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    usage(`--metrics ${path}: ${(err as Error).message}`);
  }
  const parsed = MappingSchema.safeParse(json);
  if (!parsed.success) {
    usage(
      `--metrics ${path} is not a parts mapping:\n` +
        parsed.error.issues
          .map((i) => `  ${i.path.join(".")}: ${i.message}`)
          .join("\n"),
    );
  }
  const mapping = parsed.data;
  if (mapping.proto !== proto) {
    usage(
      `--metrics ${path} maps ${mapping.proto}, but --name is ${proto} — pass the mapping kept for this prototype`,
    );
  }

  const effective: Record<string, string> = {};
  for (const o of options) effective[o.name] = picks[o.name] ?? o.default;

  const problems: string[] = [];
  const seen = new Set<string>();
  const targets: MetricTarget[] = [];
  const matches = (when: Record<string, string> | undefined): boolean =>
    Object.entries(when ?? {}).every(([n, v]) => effective[n] === v);
  const appSetup: AppSetupStep[] = [];
  (mapping.appSetup ?? []).forEach((st, i) => {
    problems.push(...whenProblems(`appSetup.${i}`, st.when, options));
    if (matches(st.when)) appSetup.push({ click: st.click, note: st.note });
  });
  mapping.parts.forEach((e, i) => {
    const key = entryKey(e);
    if (seen.has(key)) {
      problems.push(
        `parts.${i}: "${key}" twice — give one a "label" (or a different nth)`,
      );
    }
    seen.add(key);
    problems.push(...whenProblems(`parts.${i}`, e.when, options));
    if (
      e.hover !== true &&
      (e.hoverTarget !== undefined || e.appHoverTarget !== undefined)
    ) {
      problems.push(
        `parts.${i}: hoverTarget / appHoverTarget without "hover": true`,
      );
    }
    if (!matches(e.when)) return;
    const appHover = e.appHoverTarget;
    targets.push({
      key,
      part: e.part,
      props: expandProps(e.props),
      hover: e.hover === true,
      mock: {
        selector: e.mock,
        nth: e.nth ?? 0,
        hoverTarget: e.hoverTarget ?? null,
      },
      app: {
        selector: e.app ?? partSelector(e.part),
        nth: e.appNth ?? e.nth ?? 0,
        hoverTarget:
          appHover === undefined
            ? null
            : KNOWN_PARTS.includes(appHover)
              ? partSelector(appHover)
              : appHover,
      },
    });
  });
  if (problems.length > 0) {
    usage(`--metrics ${path}:\n  ${problems.join("\n  ")}`);
  }
  return { targets, appSetup };
}

// --- measuring ------------------------------------------------------------

/** A colour as the page resolved it: sRGB 0–255 + alpha 0–1, and the computed text. */
interface RawColor {
  css: string;
  rgba: [number, number, number, number] | null;
}

/** What the page reports for one element — every property, the run picks. */
type RawValues = Record<string, number | string | RawColor>;

type RawResult =
  | { kind: "ok"; values: RawValues }
  | { kind: "missing"; count: number; reason: string };

/**
 * Runs IN the frame (serialized — self-contained, no imports). `root` scopes
 * the queries and is the origin of the box; null = the frame's document and
 * viewport (an iframe).
 */
function measureInPage(arg: {
  root: string | null;
  items: { selector: string; nth: number }[];
}): RawResult[] {
  const rootEl = arg.root === null ? null : document.querySelector(arg.root);
  if (arg.root !== null && !rootEl) {
    return arg.items.map(() => ({
      kind: "missing" as const,
      count: 0,
      reason: `root ${arg.root} not found`,
    }));
  }
  const scope: ParentNode = rootEl ?? document;
  const origin = rootEl ? rootEl.getBoundingClientRect() : { left: 0, top: 0 };
  const probe = document.createElement("span");
  probe.style.display = "none";
  document.body.appendChild(probe);

  const num = (s: string): number => (s === "normal" ? 0 : parseFloat(s));
  const round = (n: number): number => Math.round(n * 100) / 100;
  // Any computed colour (oklab, color-mix results, rgb) through relative
  // colour syntax into `color(srgb r g b / a)` floats — no canvas round-trip,
  // which loses precision at low alpha.
  const color = (css: string): RawColor => {
    probe.style.color = "";
    probe.style.color = `color(from ${css} srgb r g b / alpha)`;
    const out = getComputedStyle(probe).color;
    let m =
      /^color\(srgb ([\d.e+-]+) ([\d.e+-]+) ([\d.e+-]+)(?: \/ ([\d.e+-]+))?\)$/.exec(
        out,
      );
    if (m) {
      return {
        css,
        rgba: [
          Number(m[1]) * 255,
          Number(m[2]) * 255,
          Number(m[3]) * 255,
          m[4] === undefined ? 1 : Number(m[4]),
        ],
      };
    }
    m = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(
      css,
    );
    if (m) {
      return {
        css,
        rgba: [
          Number(m[1]),
          Number(m[2]),
          Number(m[3]),
          m[4] === undefined ? 1 : Number(m[4]),
        ],
      };
    }
    return { css, rgba: null };
  };
  const firstFamily = (list: string): string => {
    const first = /^\s*("[^"]*"|'[^']*'|[^,]*)/.exec(list)?.[1] ?? list;
    return first.trim().replace(/^["']|["']$/g, "");
  };

  const results = arg.items.map((item): RawResult => {
    let all: NodeListOf<Element>;
    try {
      all = scope.querySelectorAll(item.selector);
    } catch (err) {
      return {
        kind: "missing",
        count: 0,
        reason: `invalid selector: ${(err as Error).message}`,
      };
    }
    const el = all[item.nth];
    if (!el) {
      return {
        kind: "missing",
        count: all.length,
        reason:
          all.length === 0
            ? "matches nothing"
            : `nth ${item.nth} but only ${all.length} match`,
      };
    }
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const rawRadius = cs.borderTopLeftRadius.endsWith("%")
      ? (parseFloat(cs.borderTopLeftRadius) / 100) * r.width
      : parseFloat(cs.borderTopLeftRadius);
    // The effective radius: a 999px and a 3.35544e+07px pill are both a pill.
    const radius = Math.min(rawRadius, Math.min(r.width, r.height) / 2);
    return {
      kind: "ok",
      values: {
        x: round(r.left - origin.left),
        y: round(r.top - origin.top),
        width: round(r.width),
        height: round(r.height),
        "padding-top": num(cs.paddingTop),
        "padding-right": num(cs.paddingRight),
        "padding-bottom": num(cs.paddingBottom),
        "padding-left": num(cs.paddingLeft),
        "row-gap": num(cs.rowGap),
        "column-gap": num(cs.columnGap),
        "font-size": num(cs.fontSize),
        "font-weight": Number(cs.fontWeight),
        "line-height":
          cs.lineHeight === "normal" ? "normal" : round(num(cs.lineHeight)),
        "font-family": firstFamily(cs.fontFamily),
        "letter-spacing": round(num(cs.letterSpacing)),
        "text-transform": cs.textTransform,
        "border-radius": round(radius),
        "border-width": num(cs.borderTopWidth),
        "border-color": color(cs.borderTopColor),
        color: color(cs.color),
        "background-color": color(cs.backgroundColor),
        "box-shadow": cs.boxShadow,
        opacity: Number(cs.opacity),
      },
    };
  });
  probe.remove();
  return results;
}

/** Runs IN the frame: tag the element (or its closest `hoverTarget`) to hover. */
function markHoverInPage(arg: {
  root: string | null;
  selector: string;
  nth: number;
  hoverTarget: string | null;
  attr: string;
}): string | null {
  for (const old of document.querySelectorAll(`[${arg.attr}]`)) {
    old.removeAttribute(arg.attr);
  }
  const scope: ParentNode =
    arg.root === null
      ? document
      : (document.querySelector(arg.root) ?? document);
  const el = scope.querySelectorAll(arg.selector)[arg.nth];
  if (!el) return "matches nothing";
  const target = arg.hoverTarget === null ? el : el.closest(arg.hoverTarget);
  if (!target) return `no ancestor matches hover target ${arg.hoverTarget}`;
  target.setAttribute(arg.attr, "");
  return null;
}

const HOVER_ATTR = "data-part-metrics-hover";
/** Long enough for the slowest hover transition the mocks use (.6s). */
const HOVER_SETTLE_MS = 700;

/** One side of the comparison: the frame to measure in and, for a counterpart drawn inline, its root. */
export interface MetricsScope {
  frame: Frame;
  root: string | null;
}

/** Runs IN the frame: how many elements match, and tag the first for a click. */
function markClickInPage(arg: {
  root: string | null;
  selector: string;
  attr: string;
}): { count: number; error?: string } {
  for (const old of document.querySelectorAll(`[${arg.attr}]`)) {
    old.removeAttribute(arg.attr);
  }
  const scope: ParentNode =
    arg.root === null
      ? document
      : (document.querySelector(arg.root) ?? document);
  let all: NodeListOf<Element>;
  try {
    all = scope.querySelectorAll(arg.selector);
  } catch (err) {
    return { count: 0, error: `invalid selector: ${(err as Error).message}` };
  }
  if (all.length === 1) all[0]?.setAttribute(arg.attr, "");
  return { count: all.length };
}

const CLICK_ATTR = "data-part-metrics-click";

/**
 * Make the app-side setup clicks, in order, in the counterpart's scope. Each
 * selector must match exactly one element; after each click the app settles
 * (load, two animation frames, a pause). Returns the failures — empty when all
 * ran. Nothing is undone: the click's own effect is the state to measure.
 */
export async function runAppSetup(
  page: Page,
  scope: MetricsScope,
  steps: readonly AppSetupStep[],
): Promise<string[]> {
  for (const step of steps) {
    const res = await scope.frame.evaluate(markClickInPage, {
      root: scope.root,
      selector: step.click,
      attr: CLICK_ATTR,
    });
    if (res.count !== 1) {
      return [
        `app setup click ${step.click}: ${
          res.error ??
          (res.count === 0
            ? "matches nothing"
            : `matches ${res.count} elements, needs exactly one`)
        }`,
      ];
    }
    console.log(`app setup: click ${step.click}`);
    await scope.frame.locator(`[${CLICK_ATTR}]`).click({ timeout: 5000 });
    await scope.frame.waitForLoadState("load");
    await scope.frame.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await page.waitForTimeout(500);
  }
  await scope.frame.evaluate((attr) => {
    for (const old of document.querySelectorAll(`[${attr}]`)) {
      old.removeAttribute(attr);
    }
  }, CLICK_ATTR);
  return [];
}

export interface Missing {
  side: "mock" | "app";
  key: string;
  selector: string;
  nth: number;
  reason: string;
}

/**
 * Measure every target on one side: the resting ones in one evaluate, then
 * each hover target alone (hover, settle, measure, move away) — after the
 * resting pass, so a hover's scroll-into-view cannot shift a resting box.
 */
export async function measureSide(
  page: Page,
  scope: MetricsScope,
  side: "mock" | "app",
  targets: readonly MetricTarget[],
): Promise<{ values: Map<string, RawValues>; missing: Missing[] }> {
  const values = new Map<string, RawValues>();
  const missing: Missing[] = [];
  const take = (t: MetricTarget, res: RawResult | undefined): void => {
    const s = t[side];
    if (!res) throw new Error(`no measurement returned for ${t.key}`);
    if (res.kind === "ok") {
      values.set(t.key, {
        ...res.values,
        "box-shadow": normalizeBoxShadow(String(res.values["box-shadow"])),
      });
    } else {
      missing.push({
        side,
        key: t.key,
        selector: s.selector,
        nth: s.nth,
        reason: res.reason,
      });
    }
  };

  const resting = targets.filter((t) => !t.hover);
  const restingRes = await scope.frame.evaluate(measureInPage, {
    root: scope.root,
    items: resting.map((t) => ({
      selector: t[side].selector,
      nth: t[side].nth,
    })),
  });
  resting.forEach((t, i) => take(t, restingRes[i]));

  for (const t of targets.filter((x) => x.hover)) {
    const s = t[side];
    await page.mouse.move(0, 0);
    const why = await scope.frame.evaluate(markHoverInPage, {
      root: scope.root,
      selector: s.selector,
      nth: s.nth,
      hoverTarget: s.hoverTarget,
      attr: HOVER_ATTR,
    });
    if (why !== null) {
      missing.push({
        side,
        key: t.key,
        selector: s.selector,
        nth: s.nth,
        reason: why,
      });
      continue;
    }
    await scope.frame.locator(`[${HOVER_ATTR}]`).hover({ timeout: 5000 });
    await page.waitForTimeout(HOVER_SETTLE_MS);
    const [res] = await scope.frame.evaluate(measureInPage, {
      root: scope.root,
      items: [{ selector: s.selector, nth: s.nth }],
    });
    take(t, res);
    await page.mouse.move(0, 0);
  }
  return { values, missing };
}

// --- comparing ------------------------------------------------------------

export interface MetricRow {
  part: string;
  key: string;
  prop: MetricProp;
  mock: string;
  app: string;
  /** Signed app − mock for numbers, ΔE for colours, `≠` for text. */
  delta: string;
  ok: boolean;
}

const fmtNum = (n: number): string =>
  Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "");

function rgba(c: RawColor, key: string, side: string): Rgba {
  if (!c.rgba) {
    throw new Error(
      `${key}: the ${side}'s colour "${c.css}" could not be resolved to sRGB`,
    );
  }
  const [r, g, b, a] = c.rgba;
  return { r, g, b, a };
}

function fmtColor(c: Rgba): string {
  const hex = `#${[c.r, c.g, c.b]
    .map((v) =>
      Math.round(Math.min(255, Math.max(0, v)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
  return c.a >= 0.999 ? hex : `${hex}/${fmtNum(Math.round(c.a * 100) / 100)}`;
}

/** ΔE of the two colours composited over black and over white — the worse. */
function colorDelta(a: Rgba, b: Rgba): number {
  const over = (c: Rgba, bg: number): Rgba => ({
    r: c.r * c.a + bg * (1 - c.a),
    g: c.g * c.a + bg * (1 - c.a),
    b: c.b * c.a + bg * (1 - c.a),
    a: 1,
  });
  return Math.max(
    deltaE(over(a, 0), over(b, 0)),
    deltaE(over(a, 255), over(b, 255)),
  );
}

function compareProp(
  prop: MetricProp,
  m: number | string | RawColor,
  a: number | string | RawColor,
  tol: Tolerance,
  key: string,
): Pick<MetricRow, "mock" | "app" | "delta" | "ok"> {
  const kind: PropKind = PROP_KIND[prop];
  if (kind === "color") {
    const cm = rgba(m as RawColor, key, "mock");
    const ca = rgba(a as RawColor, key, "app");
    const d = colorDelta(cm, ca);
    return {
      mock: fmtColor(cm),
      app: fmtColor(ca),
      delta: `ΔE ${d.toFixed(1)}`,
      ok: d <= tol.de,
    };
  }
  if (typeof m === "number" && typeof a === "number") {
    const d = a - m;
    const limit =
      kind === "weight"
        ? tol.weight
        : kind === "opacity"
          ? tol.opacity
          : tol.px;
    return {
      mock: fmtNum(m),
      app: fmtNum(a),
      delta:
        d === 0
          ? "0"
          : `${d > 0 ? "+" : ""}${fmtNum(Math.round(d * 100) / 100)}`,
      ok: Math.abs(d) <= limit + 1e-9,
    };
  }
  const sm = String(m);
  const sa = String(a);
  const same =
    prop === "font-family" ? sm.toLowerCase() === sa.toLowerCase() : sm === sa;
  return { mock: sm, app: sa, delta: same ? "" : "≠", ok: same };
}

/** Every (target, prop) row; a border colour under no border on either side is not compared. */
export function compareMetrics(
  targets: readonly MetricTarget[],
  mock: Map<string, RawValues>,
  app: Map<string, RawValues>,
  tol: Tolerance,
): MetricRow[] {
  const rows: MetricRow[] = [];
  for (const t of targets) {
    const m = mock.get(t.key);
    const a = app.get(t.key);
    if (!m || !a) continue;
    for (const prop of t.props) {
      if (
        prop === "border-color" &&
        m["border-width"] === 0 &&
        a["border-width"] === 0
      ) {
        continue;
      }
      const mv = m[prop];
      const av = a[prop];
      if (mv === undefined || av === undefined) {
        throw new Error(`${t.key}: no ${prop} measured`);
      }
      rows.push({
        part: t.part,
        key: t.key,
        prop,
        ...compareProp(prop, mv, av, tol, t.key),
      });
    }
  }
  return rows;
}

const clip = (s: string, n: number): string =>
  s.length <= n ? s : `${s.slice(0, n - 1)}…`;

/** The transcript table: part · prop · mock · app · Δ · ok, a part's name once per block. */
export function metricsTableText(rows: readonly MetricRow[]): string {
  const cols = {
    part: Math.max(4, ...rows.map((r) => r.key.length)),
    prop: Math.max(4, ...rows.map((r) => r.prop.length)),
    mock: Math.min(28, Math.max(4, ...rows.map((r) => r.mock.length))),
    app: Math.min(28, Math.max(3, ...rows.map((r) => r.app.length))),
    delta: Math.max(1, ...rows.map((r) => r.delta.length)),
  };
  const line = (
    part: string,
    prop: string,
    mock: string,
    app: string,
    delta: string,
    ok: string,
  ): string =>
    [
      part.padEnd(cols.part),
      prop.padEnd(cols.prop),
      clip(mock, cols.mock).padEnd(cols.mock),
      clip(app, cols.app).padEnd(cols.app),
      delta.padStart(cols.delta),
      ok,
    ]
      .join("  ")
      .trimEnd();
  const out = [line("part", "prop", "mock", "app", "Δ", "ok")];
  let last = "";
  for (const r of rows) {
    out.push(
      line(
        r.key === last ? "" : r.key,
        r.prop,
        r.mock,
        r.app,
        r.delta,
        r.ok ? "ok" : "✗",
      ),
    );
    last = r.key;
  }
  return out.join("\n");
}
