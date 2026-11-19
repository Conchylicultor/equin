/**
 * What a regular expression needs of the browser that the floor lacks — the
 * one verdict both holders of the floor read: `no-api-above-floor` (repo code,
 * per file) and the `browser-floor:vendor-sets` probe (npm code as the vendor
 * build bundled it).
 */
import type { AboveFloor, AboveFloorTable } from "./above-floor";
import { regexpFeatures } from "./regexp-features";

export interface RegexpHit {
  /** In words: "the `unicodeSets` flag", "`modifier` syntax". */
  what: string;
  hit: AboveFloor;
  /**
   * The flag's `RegExp` member, for a flag hit: a caller that sees a feature
   * test of that member (`"unicodeSets" in RegExp.prototype ? …`) passes it.
   */
  member?: string;
}

export type RegexpVerdict =
  | { ok: true; hits: RegexpHit[] }
  /** The pattern does not parse with these flags: an error in every engine. */
  | { ok: false; error: string };

/** The flags and syntax of `/pattern/flags` newer than the floor. */
export function regexpAboveFloor(
  pattern: string,
  flags: string,
  table: AboveFloorTable,
): RegexpVerdict {
  const features = regexpFeatures(pattern, flags);
  if (!features.ok) return features;
  const hits: RegexpHit[] = [];
  for (const f of features.unknownFlags)
    hits.push({
      what: `the flag \`${f}\``,
      hit: { key: "no such flag", needs: "every browser" },
    });
  for (const member of features.flagMembers) {
    const hit = table.members.get("RegExp")?.get(member);
    if (hit !== undefined)
      hits.push({ what: `the \`${member}\` flag`, hit, member });
  }
  for (const feature of features.syntax) {
    const hit = table.regexpSyntax.get(feature);
    if (hit !== undefined) hits.push({ what: `\`${feature}\` syntax`, hit });
  }
  return { ok: true, hits };
}
