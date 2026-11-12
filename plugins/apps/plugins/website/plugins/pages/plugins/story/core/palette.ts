/**
 * The story's drawing palette: the six roles every figure of the story is
 * drawn in (ported from the prototype `proto-1794207359-w7ez6h`, whose
 * figures name only these), each read from the site's theme — so a figure
 * follows the site's light / dark mode like the prose around it, and never
 * spells a colour of its own.
 *
 * - `--fg` ink, `--fg2` the secondary text tier, `--fg3` the faint tier
 * - `--line` a hairline, `--panel` a figure's card
 * - `--hl` the ONE colour a figure uses for the thing that changes (the skills,
 *   the meta skills, the friction, the agent being reviewed)
 *
 * The custom properties as a record (an element's inline style, e.g. React's
 * `style`), and the same as a declaration list ({@link STORY_PALETTE_DECLS})
 * for a stylesheet: a shadow root's `:host`.
 */
export const STORY_PALETTE: Readonly<Record<`--${string}`, string>> = {
  "--fg": "var(--foreground)",
  "--fg2": "var(--muted-foreground)",
  "--fg3": "var(--faint-foreground)",
  "--line": "var(--border)",
  "--panel": "var(--card)",
  "--bg": "var(--background)",
  "--hl": "var(--primary)",
  "--mono": "var(--font-mono)",
};

/** {@link STORY_PALETTE} as a declaration list, for a stylesheet rule's body. */
export const STORY_PALETTE_DECLS = Object.entries(STORY_PALETTE)
  .map(([k, v]) => `${k}:${v}`)
  .join(";");
