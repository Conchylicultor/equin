/**
 * The options rule, as both launch prompts state it. The prompts are the only
 * instruction guaranteed to reach a prototype agent, and the owner chose
 * instructions — not a check — as the guard against agents drawing their own
 * switchers, so it has to be said here, in one wording.
 */
export const OPTIONS_RULE = [
  "If the design has variants to flip between (a layout, a density, an accent",
  'color), declare them as options — `<meta name="prototype-option">` plus the',
  "default on `<html data-…>`, see `prototypes/CLAUDE.md` § Options — and the app",
  "draws the picker. Never build a switcher, toggle bar or settings panel into the",
  "page for that. A color is a `color` option (`accent: color violet=#7c5cff |",
  'azure=#3b82f6`, default in `<html style="--accent: …">`, read with',
  "`var(--accent)`), never a palette enum — the reader can then pick any color.",
  'Many options? Group them with `<meta name="prototype-option-group" content="Sidebar">`:',
  "every option declared after it belongs to that group, drawn as one section.",
].join("\n");
