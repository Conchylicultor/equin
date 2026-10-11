import { z } from "zod";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";

/**
 * The size presets a prototype is designed at and viewed at: the device's
 * SCREEN, in CSS pixels at the device's default scaling. One list for the whole
 * Prototypes app — the tag an author writes, the canvas's size menu, the
 * gallery thumbnail and Compare all read it, so a size one of them knows is a
 * size all of them know.
 *
 * Each is a real, common device rather than a CSS breakpoint: a mock judged at
 * a width nobody's screen has is judged against a layout nobody sees.
 * Phone: iPhone 13–15. Tablet: iPad Air. Laptop: MacBook Air (and the most
 * common laptop width). Desktop: a 1080p monitor. Wide: a 27" 1440p monitor.
 */
export const SIZE_PRESETS = [
  { name: "Phone", w: 390, h: 844 },
  { name: "Tablet", w: 820, h: 1180 },
  { name: "Laptop", w: 1440, h: 900 },
  { name: "Desktop", w: 1920, h: 1080 },
  { name: "Wide", w: 2560, h: 1440 },
] as const;

export type PresetName = (typeof SIZE_PRESETS)[number]["name"];

/**
 * The size a prototype declares with `<meta name="prototype-viewport">`: a
 * preset; `window` — the size a page gets in the VIEWER's own browser window,
 * so the mock is judged at exactly the room the real app will have on their
 * machine; or `responsive` — the page fills whatever room it is given (a
 * component mock, a layout meant to stretch).
 *
 * Named, never pixels: a free `WxH` was an arbitrary number per prototype
 * (1320x868, 1360x860, 1440x900 …) that matched no preset, so the canvas could
 * only show it as "Custom". What an author means is the KIND of screen.
 */
export type PrototypeViewport =
  | { kind: "responsive" }
  | { kind: "window" }
  | { kind: "preset"; preset: PresetName };

/**
 * What a prototype that declares no size is: a page that fills whatever room
 * the canvas gives it, so a fresh canvas shows the mock at the pane's own size
 * (100%, no letterboxing) and the page's own responsive layout. An author
 * pins a fixed screen by declaring `window` or a preset.
 */
export const DEFAULT_PROTOTYPE_VIEWPORT = {
  kind: "responsive",
} as const satisfies PrototypeViewport;

/**
 * The preset a size with no fixed pixels of its own (`window`, `responsive`)
 * renders at where there is no viewer's window to measure — a headless browser
 * taking a thumbnail, Compare sizing its window.
 */
export const HEADLESS_PRESET: PresetName = "Laptop";

const isPresetName = (v: unknown): v is PresetName =>
  SIZE_PRESETS.some((p) => p.name === v);

/** The wire shape of a declared size. Mirrors `PrototypeViewport` exactly. */
export const PrototypeViewportSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("responsive") }),
  z.object({ kind: z.literal("window") }),
  z.object({
    kind: z.literal("preset"),
    preset: z.custom<PresetName>(isPresetName, "not a size preset"),
  }),
]) satisfies ZodParser<PrototypeViewport>;

/** The words the tag accepts: `window`, `responsive`, then each preset lowercased. */
export const PROTOTYPE_VIEWPORT_WORDS: readonly string[] = [
  "window",
  "responsive",
  ...SIZE_PRESETS.map((p) => p.name.toLowerCase()),
];

/**
 * Parse the tag's `content`. Absent or blank is the default (not a problem);
 * a word outside {@link PROTOTYPE_VIEWPORT_WORDS} — the old `1320x868` form
 * included — is `malformed`, which the folder's problems report and every
 * reader treats as the default.
 */
export function parseViewport(
  raw: string | undefined,
): { ok: true; viewport: PrototypeViewport } | { ok: false; raw: string } {
  const word = (raw ?? "").trim().toLowerCase();
  if (word === "") return { ok: true, viewport: DEFAULT_PROTOTYPE_VIEWPORT };
  if (word === "responsive")
    return { ok: true, viewport: { kind: "responsive" } };
  if (word === "window") return { ok: true, viewport: { kind: "window" } };
  const preset = SIZE_PRESETS.find((p) => p.name.toLowerCase() === word);
  return preset
    ? { ok: true, viewport: { kind: "preset", preset: preset.name } }
    : { ok: false, raw: (raw ?? "").trim() };
}

/** The tag's word for a size — the inverse of {@link parseViewport}. */
export function viewportWord(v: PrototypeViewport): string {
  return v.kind === "preset" ? v.preset.toLowerCase() : v.kind;
}

/** The `problems[]` detail for a tag {@link parseViewport} refused. */
export function viewportProblemDetail(raw: string): string {
  return `<meta name="prototype-viewport" content="${raw}"> is not a size — write one of ${PROTOTYPE_VIEWPORT_WORDS.join(", ")} (the default is ${viewportWord(DEFAULT_PROTOTYPE_VIEWPORT)}). Pixel sizes are no longer read`;
}

/** A preset's logical size. */
export function presetSize(name: PresetName): { w: number; h: number } {
  const preset = SIZE_PRESETS.find((p) => p.name === name);
  if (!preset) throw new Error(`unknown size preset "${name}"`);
  return { w: preset.w, h: preset.h };
}

/**
 * The fixed size to render a prototype at where there is no room to fill and
 * no viewer's window to measure — a headless browser taking its thumbnail,
 * Compare sizing its window. `window` and `responsive` render at
 * {@link HEADLESS_PRESET}.
 */
export function viewportRenderSize(v: PrototypeViewport): {
  w: number;
  h: number;
} {
  return presetSize(v.kind === "preset" ? v.preset : HEADLESS_PRESET);
}
