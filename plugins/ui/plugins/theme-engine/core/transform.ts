import type { ColorAdjustment } from "./theme";

const OKLCH_RE =
  /oklch\(([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)((?:\s*\/\s*[^)]+)?)\)/g;

export function transformOklch(value: string, adj: ColorAdjustment): string {
  return value.replace(
    OKLCH_RE,
    (_match, l: string, c: string, h: string, alpha: string) => {
      const L = Math.min(1, Math.max(0, parseFloat(l) * adj.lightnessScale));
      const C = Math.max(0, parseFloat(c) * adj.saturationScale);
      const H = (((parseFloat(h) + adj.hueShift) % 360) + 360) % 360;
      return `oklch(${L.toFixed(4)} ${C.toFixed(4)} ${H.toFixed(2)}${alpha})`;
    },
  );
}

export function transformValues(
  values: Record<string, string>,
  adj: ColorAdjustment,
): Record<string, string> {
  if (
    adj.hueShift === 0 &&
    adj.saturationScale === 1 &&
    adj.lightnessScale === 1
  ) {
    return values;
  }
  return Object.fromEntries(
    Object.entries(values).map(([k, v]) => [k, transformOklch(v, adj)]),
  );
}
