// Distinct hues around the wheel, in the order participants / groups take them.
const HUES = [250, 295, 165, 70, 15, 200, 335, 110];

/**
 * The colour of the i-th participant: a categorical hue at the lightness and
 * chroma the stage sets for the colour scheme in force (`--mmd-l` / `--mmd-c`,
 * stage.css) — deeper and more saturated on a light surface, lighter on a dark
 * one — so it stays clean in both rather than drifting toward the foreground.
 */
export function participantHue(i: number): string {
  const hue = HUES[i % HUES.length]!;
  return `oklch(var(--mmd-l) var(--mmd-c) ${hue})`;
}
