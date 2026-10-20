// Distinct hues around the wheel, in the order participants / groups take them.
const HUES = [250, 300, 160, 65, 20, 200, 335, 110];

/**
 * The colour of the i-th participant: a categorical hue pulled toward the
 * theme's foreground, so it reads on the surface in either scheme — lighter on
 * a dark theme, deeper on a light one — without knowing which is in force.
 */
export function participantHue(i: number): string {
  const hue = HUES[i % HUES.length]!;
  return `color-mix(in oklch, oklch(0.66 0.16 ${hue}) 72%, var(--foreground))`;
}
