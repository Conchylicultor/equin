/**
 * The device screens equin is designed and checked at: each device's SCREEN,
 * in CSS pixels at its default scaling. One list for the whole app — the
 * prototype canvas's size menu, its `prototype-viewport` tag, Compare and the
 * action bar's phone window all read it, so a size one of them knows is a size
 * all of them know.
 *
 * Each is a real, common device rather than a CSS breakpoint: a layout judged
 * at a width nobody's screen has is judged against a layout nobody sees.
 * Phone: iPhone 13–15, held upright; Phone landscape: the same phone on its
 * side. Tablet: iPad Air. Laptop: MacBook Air (and the most common laptop
 * width). Desktop: a 1080p monitor. Wide: a 27" 1440p monitor.
 *
 * `word` spells the size as one token, never a space (a tag's content, a URL).
 */
export const DEVICE_SIZES = [
  { name: "Phone", word: "phone", w: 390, h: 844 },
  { name: "Phone landscape", word: "phone-landscape", w: 844, h: 390 },
  { name: "Tablet", word: "tablet", w: 820, h: 1180 },
  { name: "Laptop", word: "laptop", w: 1440, h: 900 },
  { name: "Desktop", word: "desktop", w: 1920, h: 1080 },
  { name: "Wide", word: "wide", w: 2560, h: 1440 },
] as const;

export type DeviceSize = (typeof DEVICE_SIZES)[number];
export type DeviceSizeName = DeviceSize["name"];

/** One device's screen size. */
export function deviceSize(name: DeviceSizeName): { w: number; h: number } {
  const size = DEVICE_SIZES.find((s) => s.name === name);
  if (!size) throw new Error(`unknown device size "${name}"`);
  return { w: size.w, h: size.h };
}
