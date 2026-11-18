/**
 * Free text (a song's title, a chord grid) spelled for a share link so the
 * address stays readable: `encodeURIComponent` — which the route applies to
 * every keyed value — turns each space into `%20`, each newline into `%0A`
 * and each `;` (a chord grid's comment marker, the route's own separator)
 * into `%3B`. Here they become characters it leaves alone: a space `_`, a
 * newline `~`, a `;` `!`. `*` escapes a literal one of `_ ~ ! *`, so the
 * spelling round-trips any text.
 *
 * `key: Eb⏎; Intro⏎(Abmaj7 Gm7)` → `key%3A_Eb~!_Intro~(Abmaj7_Gm7)`.
 */
const TO_LINK: Readonly<Record<string, string>> = {
  " ": "_",
  "\n": "~",
  ";": "!",
};
const FROM_LINK: Readonly<Record<string, string>> = {
  _: " ",
  "~": "\n",
  "!": ";",
};
const ESCAPE = "*";

/** `text` in its readable link spelling (see the module doc). */
export function toLinkText(text: string): string {
  let out = "";
  for (const ch of text) {
    const mapped = TO_LINK[ch];
    if (mapped !== undefined) out += mapped;
    else if (ch === ESCAPE || FROM_LINK[ch] !== undefined) out += ESCAPE + ch;
    else out += ch;
  }
  return out;
}

/**
 * The text a link value spells — the inverse of {@link toLinkText}. A value
 * written before this spelling (plain text, spaces and all) reads back as
 * itself unless it holds one of `_ ~ ! *`.
 */
export function fromLinkText(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === ESCAPE && i + 1 < value.length) {
      out += value[++i];
      continue;
    }
    out += FROM_LINK[ch] ?? ch;
  }
  return out;
}
