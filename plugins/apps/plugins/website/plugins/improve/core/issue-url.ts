import { splitUiContext } from "@plugins/primitives/plugins/ui-context/core";

/**
 * GitHub rejects a new-issue link much past 8,000 characters, and the text is
 * the only part of the link a visitor controls. So the whole URL is held under
 * this, with room to spare, by giving up the picks' raw tags and then the text
 * — never the title, the page or the auto-deploy line, which are what make the
 * issue actionable.
 */
export const MAX_ISSUE_URL_LENGTH = 7_500;

/** The longest title GitHub's list shows without clipping it itself. */
const MAX_TITLE_LENGTH = 72;

/** GitHub applies it only for a visitor with triage rights; others file unlabelled. */
const LABEL = "idea";

export interface IssueDraft {
  /** The repository's home URL — `https://github.com/<owner>/<repo>`. */
  repoUrl: string;
  /** What the visitor wrote, as typed — `<ui-context>` tags for their picks included. */
  text: string;
  /** The page they were on when they wrote it. */
  pageUrl: string;
  /** Whether they asked for the change to ship without a review. */
  autoDeploy: boolean;
}

/** One part of the page the visitor pointed at, as its tag sits in their text. */
export interface IssuePick {
  /** 1-based, in reading order: the `[n]` the readable text and the body share. */
  n: number;
  /** The picked element's label, e.g. `h1 — What will apps evolve into?`. */
  label: string;
  /** The raw `<ui-context>` tag, which the body carries verbatim for an agent. */
  tag: string;
  /** The file behind the element, e.g. `hero.tsx` — when the build stamped one. */
  file?: string;
}

/** The visitor's text with every pick made readable, and the picks themselves. */
export interface ReadableIdea {
  /** Each tag replaced by `` `<label>` [n] ``. */
  text: string;
  picks: IssuePick[];
}

/** The longest run of backticks in `s` — what a code span or fence around it must beat. */
function longestBacktickRun(s: string): number {
  return Math.max(0, ...(s.match(/`+/g) ?? []).map((run) => run.length));
}

/**
 * `s` as inline code. A label is page text, so it may hold backticks: the
 * delimiter is one longer than any run inside, and padded with a space when the
 * label starts or ends with one (CommonMark strips that space back off).
 */
function codeSpan(s: string): string {
  const tick = "`".repeat(longestBacktickRun(s) + 1);
  const pad = s.startsWith("`") || s.endsWith("`") ? " " : "";
  return `${tick}${pad}${s}${pad}${tick}`;
}

/** `plugins/…/hero.tsx:42` → `hero.tsx`: the `data-source` stamp's file name. */
function fileName(source: string): string {
  return source.replace(/:\d+$/, "").split("/").at(-1) ?? source;
}

/**
 * The visitor's text as a person reads it: each `<ui-context>` tag becomes
 * `` `<label>` [n] ``, numbered in the order the picks appear. The raw tags are
 * kept on the picks, for the body's collapsed blocks.
 *
 * A tag the parser refuses is left as the characters typed — which is also how
 * the field draws it, so the issue says what the visitor saw.
 */
export function readableIdea(text: string): ReadableIdea {
  const picks: IssuePick[] = [];
  const parts = splitUiContext(text).map((segment) => {
    switch (segment.kind) {
      case "text":
        return segment.text;
      case "malformed":
        return segment.raw;
      case "tag": {
        const { element, source } = segment.meta;
        const pick: IssuePick = {
          n: picks.length + 1,
          label: element,
          tag: segment.raw,
          ...(source ? { file: fileName(source) } : {}),
        };
        picks.push(pick);
        return `${codeSpan(pick.label)} [${pick.n}]`;
      }
    }
  });
  return { text: parts.join(""), picks };
}

/** The first non-empty line of an already-readable text, cut to the title length. */
function titleOf(readable: string): string {
  const first =
    readable
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== "") ?? "";
  const chars = Array.from(first);
  return chars.length > MAX_TITLE_LENGTH
    ? `${chars.slice(0, MAX_TITLE_LENGTH - 1).join("")}…`
    : first;
}

/**
 * The issue's title: the first non-empty line of the visitor's text made
 * readable ({@link readableIdea}) — so never a raw tag — cut to
 * {@link MAX_TITLE_LENGTH} characters (the ellipsis included) when longer.
 *
 * Cut by code point, not UTF-16 unit, so an emoji at the boundary is dropped
 * whole rather than halved into a lone surrogate.
 */
export function issueTitle(text: string): string {
  return titleOf(readableIdea(text).text);
}

/**
 * How much the body carries. Shrinking it one field at a time, in the order the
 * fields are listed, is the link-length policy of {@link buildIssueUrl}.
 */
interface BodyShape {
  /** How many picks, from the first, keep their raw tag. */
  tags: number;
  /** The visitor's readable text, whole or cut. */
  text: string;
  /** How many picks, from the first, are listed; the rest are counted as "+N more". */
  listed: number;
}

/**
 * One pick with its raw tag, collapsed so it is there for an agent and out of
 * a person's way. The tag sits in a code fence, or GitHub strips it as HTML;
 * the blank lines around the fence are what make GitHub render markdown inside
 * `<details>` at all. The fence beats any backtick run in the tag, so nothing
 * in it can close the fence early — a tag the picker wrote is one line, but one
 * pasted by hand may span several.
 */
function pickDetails({ n, label, tag }: IssuePick): string {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(tag) + 1));
  const summary = `[${n}] ${label}`
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return [
    `<details><summary>${summary}</summary>`,
    "",
    `${fence}html`,
    tag,
    fence,
    "",
    "</details>",
  ].join("\n");
}

/**
 * The picks' part of the body: a collapsed block for each pick still carrying
 * its tag, then one plain `[n] <label>` line for each that gave its tag up,
 * then "+N more" for the ones no longer listed. Tags and listing are both
 * given up from the last pick, so the blocks always come before the lines.
 */
function picksSection(picks: IssuePick[], shape: BodyShape): string {
  const listed = picks.slice(0, shape.listed);
  const blocks = listed.slice(0, shape.tags).map(pickDetails);
  const lines = listed
    .slice(shape.tags)
    .map(({ n, label }) => `[${n}] ${label}`);
  const unlisted = picks.length - listed.length;
  if (unlisted > 0) lines.push(`+${unlisted} more`);
  return [...blocks, ...(lines.length > 0 ? [lines.join("\n")] : [])].join(
    "\n\n",
  );
}

function issueBody(
  picks: IssuePick[],
  shape: BodyShape,
  { pageUrl, autoDeploy }: IssueDraft,
): string {
  const section = picksSection(picks, shape);
  return [
    shape.text,
    "",
    "---",
    ...(section === "" ? [] : [section, ""]),
    `Page: ${pageUrl}`,
    `Auto-deploy: ${autoDeploy ? "yes" : "no (review first)"}`,
    "Filed from the Wish button on equin.ai",
  ].join("\n");
}

function urlFor(
  draft: IssueDraft,
  title: string,
  picks: IssuePick[],
  shape: BodyShape,
): string {
  const query = new URLSearchParams({
    title,
    body: issueBody(picks, shape, draft),
    labels: LABEL,
  });
  return `${draft.repoUrl.replace(/\/+$/, "")}/issues/new?${query.toString()}`;
}

const fits = (url: string) => url.length <= MAX_ISSUE_URL_LENGTH;

/**
 * `build(n)` for the largest `n` whose link fits, found by bisection. The
 * caller has checked that `build(0)` fits and `build(max)` does not, so the
 * answer is in `[0, max)`: `lo` always fits, `hi` never does.
 */
function largestFitting(max: number, build: (n: number) => string): string {
  let lo = 0;
  let hi = max;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (fits(build(mid))) lo = mid;
    else hi = mid;
  }
  return build(lo);
}

/**
 * A link to GitHub's new-issue form, prefilled with the visitor's idea: the
 * title from its first line, and a body holding the whole text made readable
 * ({@link readableIdea}), then a rule, a collapsed block per pick with its raw
 * tag, the page it was written on and the auto-deploy choice.
 *
 * The link is always under {@link MAX_ISSUE_URL_LENGTH}. A tag runs to several
 * hundred characters (more once encoded), so when the whole does not fit the
 * body gives things up in this order, each only once the one before is gone:
 *
 * 1. the raw tags, last pick first — that pick keeps a plain `[n] <label>` line;
 * 2. the text, cut to the longest prefix that fits and ended with "…" — the
 *    visitor lands in GitHub's editor and can paste the rest;
 * 3. the `[n]` lines, last first, counted instead as "+N more".
 *
 * The encoded length of a prefix is not proportional to its length in
 * characters (one emoji encodes to twelve), so each step's cut is found by
 * bisection rather than estimated.
 *
 * Throws if even that does not fit: that means the page URL alone is over the
 * cap, and a link GitHub would reject is not one to hand a visitor.
 */
export function buildIssueUrl(draft: IssueDraft): string {
  const idea = readableIdea(draft.text);
  const text = idea.text.trim();
  const { picks } = idea;
  const title = titleOf(text);
  const url = (shape: BodyShape) => urlFor(draft, title, picks, shape);
  const all = picks.length;

  const whole = url({ tags: all, text, listed: all });
  if (fits(whole)) return whole;

  const withTags = (tags: number) => url({ tags, text, listed: all });
  if (fits(withTags(0))) return largestFitting(all, withTags);

  const chars = Array.from(text);
  const cut = (n: number) =>
    url({ tags: 0, text: `${chars.slice(0, n).join("")}…`, listed: all });
  if (fits(cut(0))) return largestFitting(chars.length, cut);

  const listing = (listed: number) => url({ tags: 0, text: "…", listed });
  if (fits(listing(0))) return largestFitting(all, listing);

  throw new Error(
    `buildIssueUrl: the issue link is over ${MAX_ISSUE_URL_LENGTH} characters with no text at all (page URL is ${draft.pageUrl.length} characters)`,
  );
}
