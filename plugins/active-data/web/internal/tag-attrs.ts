/**
 * An open tag's attribute run, quoted values allowed to hold `>` — a
 * `<show-me path="a > b">` names a lineage path, whose separator is ` > `.
 * The source of a regex group (no flags, no anchors), for the segmenter and the
 * inline pairing to embed, so both read an open tag the same way.
 */
export const TAG_ATTRS_SOURCE = String.raw`(\s(?:[^>"']|"[^"]*"|'[^']*')*)`;

/** The attributes of an active-data open tag (`<task model="opus">` → `{ model: "opus" }`); a bare name is `""`. */
export function parseAttrs(attrStr: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /(\w[\w-]*)(?:=(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrStr)) !== null) {
    attrs[m[1]!] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return attrs;
}
