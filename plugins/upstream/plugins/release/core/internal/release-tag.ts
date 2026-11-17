import { PRODUCT_NAME } from "@plugins/framework/plugins/product-name/core";

/**
 * The release tag grammar.
 *
 * A release is an annotated tag on main named `v<YYYY.MM.DD>`, with a `.<n>`
 * suffix (n ≥ 2) for a second release the same (UTC) day: `v2026.11.14`,
 * `v2026.11.14.2`. The tag is the version — "you're on 2026.11.14" needs no
 * other state — and a clone is told about a release, never about a commit.
 *
 * Pure and web-safe: the CLI that cuts a tag, the server that detects one and
 * the web that shows one all read this file.
 */

/** Every release tag starts with this. */
export const RELEASE_TAG_PREFIX = "v";

/** The glob git matches release tags with (`git describe --match`, `tag -l`). */
export const RELEASE_TAG_GLOB = `${RELEASE_TAG_PREFIX}*`;

const RELEASE_TAG_RE = /^v(\d{4})\.(\d{2})\.(\d{2})(?:\.(\d+))?$/;

/** A parsed release tag. `seq` is 1 for the day's first release (no suffix). */
export interface ReleaseTag {
  tag: string;
  year: number;
  month: number;
  day: number;
  seq: number;
}

/**
 * What a tag name is: a release, or some other tag. Not a failure either way —
 * a repo may carry tags of its own (`v1`, `nightly`), and those are simply not
 * releases.
 */
export type ReleaseTagParse =
  { kind: "release"; release: ReleaseTag } | { kind: "other" };

export function parseReleaseTag(tag: string): ReleaseTagParse {
  const m = RELEASE_TAG_RE.exec(tag);
  if (m === null) return { kind: "other" };
  const [, y, mo, d, s] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  // `.1` is never written (the first release of a day has no suffix), so it
  // is not a release name: two spellings of one version would compare equal.
  const seq = s === undefined ? 1 : Number(s);
  if (month < 1 || month > 12 || day < 1 || day > 31) return { kind: "other" };
  if (s !== undefined && seq < 2) return { kind: "other" };
  return { kind: "release", release: { tag, year, month, day, seq } };
}

/** Newest-last order: negative when `a` is older than `b`. */
export function compareReleases(a: ReleaseTag, b: ReleaseTag): number {
  return a.year - b.year || a.month - b.month || a.day - b.day || a.seq - b.seq;
}

/** The release tags among `tags`, oldest first; every other tag dropped. */
export function releaseTags(tags: readonly string[]): ReleaseTag[] {
  const out: ReleaseTag[] = [];
  for (const t of tags) {
    const parsed = parseReleaseTag(t);
    if (parsed.kind === "release") out.push(parsed.release);
  }
  return out.sort(compareReleases);
}

/** The newest release tag among `tags`, if any is one. */
export function newestReleaseTag(
  tags: readonly string[],
): { kind: "release"; tag: string } | { kind: "none" } {
  const sorted = releaseTags(tags);
  const newest = sorted.at(-1);
  return newest === undefined
    ? { kind: "none" }
    : { kind: "release", tag: newest.tag };
}

/**
 * The name the next release cut at `now` takes, given the tags that exist:
 * `v<UTC date>`, or `.2`, `.3`, … after the day's newest. UTC so that two
 * people (or a laptop that crossed a timezone) cannot name one day twice.
 */
export function nextReleaseTag(now: Date, existing: readonly string[]): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const base = `${RELEASE_TAG_PREFIX}${now.getUTCFullYear()}.${pad(now.getUTCMonth() + 1)}.${pad(now.getUTCDate())}`;
  const sameDay = releaseTags(existing).filter(
    (r) =>
      r.year === now.getUTCFullYear() &&
      r.month === now.getUTCMonth() + 1 &&
      r.day === now.getUTCDate(),
  );
  const last = sameDay.at(-1);
  return last === undefined ? base : `${base}.${last.seq + 1}`;
}

/** How a release reads to a person: `v2026.11.14` → `2026.11.14`. */
export function releaseVersion(tag: string): string {
  return tag.startsWith(RELEASE_TAG_PREFIX)
    ? tag.slice(RELEASE_TAG_PREFIX.length)
    : tag;
}

/** The one-line message an annotated release tag carries. */
export function releaseTagMessage(tag: string): string {
  return `${PRODUCT_NAME} ${releaseVersion(tag)}`;
}
