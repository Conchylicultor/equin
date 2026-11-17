/**
 * Tailwind's spacing utility families, and the word values Tailwind resolves
 * for them on its own — the data `space-ramp/no-dead-spacing` checks a class
 * against. A closed list Tailwind defines, so plain data rather than a slot.
 *
 * Imports nothing on purpose: the lint rule imports this file relatively, and a
 * rule may load no generated manifest (`cli:codegen-manifests-not-frozen`).
 */

/** Longest prefix first, so `gap-x-sm` is read as `gap-x`, not `gap`. */
const SPACING_FAMILIES = [
  "space-x",
  "space-y",
  "gap-x",
  "gap-y",
  "gap",
  "px",
  "py",
  "pt",
  "pr",
  "pb",
  "pl",
  "ps",
  "pe",
  "p",
  "mx",
  "my",
  "mt",
  "mr",
  "mb",
  "ml",
  "ms",
  "me",
  "m",
] as const;

/** A Tailwind spacing utility family — `gap-x`, `p`, `mb`, `space-y`, … */
export type SpacingFamily = (typeof SPACING_FAMILIES)[number];

/**
 * The word values Tailwind gives a family with no theme key. app.css defines no
 * `--spacing-*` key, so every other word must be a declared `@utility`.
 */
function builtinWords(family: SpacingFamily): readonly string[] {
  if (family.startsWith("space-")) return ["px", "reverse"];
  if (family.startsWith("m")) return ["px", "auto"];
  return ["px"];
}

/**
 * Split a bare class (variants and the negative `-` already stripped) into its
 * spacing family and value, or `null` when it is not a spacing utility.
 */
export function parseSpacingClass(
  cls: string,
): { family: SpacingFamily; value: string } | null {
  for (const family of SPACING_FAMILIES) {
    if (cls.startsWith(`${family}-`)) {
      return { family, value: cls.slice(family.length + 1) };
    }
  }
  return null;
}

/**
 * Does a word-valued spacing class emit CSS? True for a Tailwind built-in word
 * (`mx-auto`, `p-px`, `space-x-reverse`) or a class app.css declares as an
 * `@utility` (`gap-sm`, `p-chip`). Anything else — `mb-xs`, `p-mdd` — compiles
 * to nothing.
 */
export function spacingClassExists(
  cls: string,
  family: SpacingFamily,
  value: string,
  declaredUtilities: { has(name: string): boolean },
): boolean {
  return builtinWords(family).includes(value) || declaredUtilities.has(cls);
}

/** Margin and space-between: the families the ramp deliberately leaves out. */
export function isMarginFamily(family: SpacingFamily): boolean {
  return family.startsWith("m") || family.startsWith("space-");
}
