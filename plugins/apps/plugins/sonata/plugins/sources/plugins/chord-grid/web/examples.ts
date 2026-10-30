/**
 * The grid text the editor shows a user before they write their own: the
 * starter a new song is born with and the empty editor's placeholder. Both are
 * the mini-language's first impression, so `examples.test.ts` parses each and
 * fails on any skipped token — a syntax change that leaves them behind (as `#`
 * comments were, once `;` replaced them) breaks the build, not the first grid.
 */

/** The text a new chord-grid song is created with — leads with a `;` section label. */
export const STARTER_TEXT = "; Verse\nC G Am F";

/** The empty editor's placeholder — a fuller tour: extended chords and a shared bar. */
export const PLACEHOLDER_TEXT =
  "; Verse\nAmaj9 Am9 (E E6) (E E6)\nCmaj7 Am7 Dm9 G13";
