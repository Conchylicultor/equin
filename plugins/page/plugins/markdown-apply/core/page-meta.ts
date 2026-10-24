// The `<page-meta>` header a read may open with, and the split that takes it
// back off a document about to be applied.
//
// It is the `# Title` banner's sibling (`./page-title.ts`) and follows the same
// two rules, for the same reasons:
//
//  - **A READER-SIDE PREFIX, never a node.** It is prepended to the finished
//    document and removed before the parse, so the forest on either side of the
//    round trip is exactly the one the engine already had. No write can name it.
//  - **Emit and read in ONE module.** If the two disagreed on a byte, a header a
//    read emitted would reach the planner as created blocks.
//
// Where it differs from the banner: the banner is stripped only on BYTE-IDENTITY
// with the stored title, because a changed title line is a rename to decide. The
// header's fields are facts held elsewhere (the page's ancestry, its timestamps, the
// pages linking to it)
// — READ-ONLY, like a tag's annotated attributes — so a header is recognised by
// its STRUCTURE and its values are ignored. That is also what lets a document
// read a minute ago still apply after the page's `edited` time moved. The one
// WRITABLE field, the page's tags, is carried here without meaning — a name and
// the line's other attributes — and read off {@link PageMetaSplit}'s `meta` by
// the caller that owns it (`agent-access`'s `edit_page`), never by this engine.
//
// Structure is checked strictly all the same: a header holding a line it does
// not know is refused rather than skipped, so a block an agent wrote inside it
// is never silently dropped.
//
// Shape:
//
//     <page-meta kind="page" created="2026-07-14T09:12Z" edited="2026-10-07T18:02Z">
//       <tags>
//         <tag name="In progress"/>
//       </tags>
//       <breadcrumb>
//         <page id="block-…" title="equin"/>
//         <page id="block-…" title="Hosted"/>
//       </breadcrumb>
//       <backlinks>
//         <page id="block-…" title="Roadmap"/>
//       </backlinks>
//     </page-meta>
//
// `kind` is the page's own kind (`pageKindOf`): `page` (the human's),
// `agent-page` (an agent may write all of it) or `instructions`. A read rooted
// at a page shows no tag for the page itself, so without it an agent reading its
// own agent page by id could not tell it from a human's page — and would take
// the page's prose for the human's while the write rule treats it as its own.
// Always stated, `page` included, for the reason `<backlinks/>` is.
//
// `<backlinks/>` (self-closing) when no page links here, and `<tags/>` when the
// page carries none: the header states an empty list rather than leaving the
// reader to guess what an absent one means. `<tags>` comes first because it is
// the one section a writer edits. A `<tag>` line may carry `name` (required)
// plus the attributes in {@link TAG_LINE_ATTRS} — what a writer adds to ask for
// a new tag; any other attribute is refused, so a typo is never silently
// dropped.
//
// A paragraph can never open with `<` in this dialect (the inline serializer
// escapes it, `core/markdown.ts`), so no block's line can be mistaken for the
// header's first line.

import {
  formatTagLine,
  parseTagLine,
  type PageKind,
} from "@plugins/page/plugins/editor/core";

const META_TAG = "page-meta";
const TAGS_TAG = "tags";
const TAG_LINE = "tag";
const BREADCRUMB_TAG = "breadcrumb";
const BACKLINKS_TAG = "backlinks";
const CRUMB_TAG = "page";
const INDENT = "  ";

/**
 * The attributes a `<tag>` line may carry besides `name`. Their meaning is the
 * writer's (`new="true"` asks for a new tag, `color` picks its color); this
 * module only admits them.
 */
const TAG_LINE_ATTRS = ["new", "color"] as const;

/**
 * One `<tag>` line: the tag's name and the line's other attributes, unjudged.
 * A read emits `attrs: {}`.
 */
export interface PageMetaTag {
  name: string;
  attrs: Record<string, string>;
}

/**
 * One page of a breadcrumb or of the backlinks: an address `read_page` takes,
 * and its title.
 */
export interface PageCrumb {
  id: string;
  title: string;
}

/** What a header states about the page a read was taken from. */
export interface PageMeta {
  /** The kind of the page holding the read — whose words its prose is. */
  kind: PageKind["kind"];
  /** When the page row was created. */
  created: Date;
  /** When the page or any of its live blocks last changed. */
  edited: Date;
  /** Root first, ending with the page itself — "where am I" for any scope. */
  breadcrumb: readonly PageCrumb[];
  /** The pages linking TO this one (`page/links`), a self-link excluded. */
  backlinks: readonly PageCrumb[];
  /** The tags the page carries, in its order (`page/tags`). */
  tags: readonly PageMetaTag[];
}

/** A header as read back: its attributes and lists, values unjudged. */
export interface ParsedPageMeta {
  attrs: Record<string, string>;
  breadcrumb: PageCrumb[];
  backlinks: PageCrumb[];
  /**
   * The `<tags>` section's lines, or `null` when the header has no `<tags>`
   * section at all (a header from before tags, or one a writer trimmed) — which
   * states nothing, where `[]` (`<tags/>`) states "no tags".
   */
  tags: PageMetaTag[] | null;
}

/** The header's page-list sections, in the order they are emitted. */
type PageListTag = typeof BREADCRUMB_TAG | typeof BACKLINKS_TAG;
const PAGE_LIST_KEY = {
  [BREADCRUMB_TAG]: "breadcrumb",
  [BACKLINKS_TAG]: "backlinks",
} as const satisfies Record<PageListTag, keyof ParsedPageMeta>;

function isPageListTag(name: string): name is PageListTag {
  return Object.hasOwn(PAGE_LIST_KEY, name);
}

/** One `<tag>` section of `<page/>` lines — self-closing when it lists none. */
function pageListLines(
  tag: PageListTag,
  pages: readonly PageCrumb[],
): string[] {
  if (pages.length === 0) return [`${INDENT}${formatTagLine(tag, {}, true)}`];
  return [
    `${INDENT}${formatTagLine(tag, {}, false)}`,
    ...pages.map(
      (page) =>
        `${INDENT}${INDENT}${formatTagLine(
          CRUMB_TAG,
          { id: page.id, title: page.title },
          true,
        )}`,
    ),
    `${INDENT}</${tag}>`,
  ];
}

/** The `<tags>` section — self-closing when the page carries none. */
function tagLines(tags: readonly PageMetaTag[]): string[] {
  if (tags.length === 0)
    return [`${INDENT}${formatTagLine(TAGS_TAG, {}, true)}`];
  return [
    `${INDENT}${formatTagLine(TAGS_TAG, {}, false)}`,
    ...tags.map(
      (tag) =>
        `${INDENT}${INDENT}${formatTagLine(
          TAG_LINE,
          { name: tag.name, ...tag.attrs },
          true,
        )}`,
    ),
    `${INDENT}</${TAGS_TAG}>`,
  ];
}

/**
 * A `<tag>` line read back, or why it is refused: `name` is required and the
 * only other attributes admitted are {@link TAG_LINE_ATTRS}.
 */
function tagOfLine(
  attrs: Record<string, string>,
): { ok: true; tag: PageMetaTag } | { ok: false; why: string } {
  const { name, ...rest } = attrs;
  if (name === undefined) {
    return { ok: false, why: `a <${TAG_LINE}> line has no name attribute` };
  }
  const allowed: readonly string[] = TAG_LINE_ATTRS;
  const stray = Object.keys(rest).filter((k) => !allowed.includes(k));
  if (stray.length > 0) {
    return {
      ok: false,
      why:
        `the <${TAG_LINE} name=${JSON.stringify(name)}> line carries ` +
        `${stray.map((k) => `"${k}"`).join(", ")}, and a tag line takes only ` +
        `name, ${TAG_LINE_ATTRS.join(" and ")}`,
    };
  }
  return { ok: true, tag: { name, attrs: rest } };
}

/** Minute precision, UTC: `2026-10-07T18:02Z`. */
function minuteIso(date: Date): string {
  return `${date.toISOString().slice(0, 16)}Z`;
}

/**
 * The header for `meta`, blank line included — so a caller writes
 * `pageMetaHeader(meta) + document` and nothing else.
 */
export function pageMetaHeader(meta: PageMeta): string {
  const lines = [
    formatTagLine(
      META_TAG,
      {
        kind: meta.kind,
        created: minuteIso(meta.created),
        edited: minuteIso(meta.edited),
      },
      false,
    ),
    ...tagLines(meta.tags),
    ...pageListLines(BREADCRUMB_TAG, meta.breadcrumb),
    ...pageListLines(BACKLINKS_TAG, meta.backlinks),
    `</${META_TAG}>`,
  ];
  return `${lines.join("\n")}\n\n`;
}

/**
 * `markdown` split into its leading header (if any) and the document after it.
 *
 * `meta: null` with `rest === markdown` when the first non-empty line is not a
 * `<page-meta>` tag — a document without a header is an ordinary document. A
 * header that opens and is then malformed (an unknown line, no closing tag) is
 * `ok: false`, never a guess about where it ends.
 */
export type PageMetaSplit =
  | { ok: true; meta: ParsedPageMeta | null; header: string; rest: string }
  | { ok: false; reason: string };

export function splitPageMeta(markdown: string): PageMetaSplit {
  const lines = markdown.split("\n");
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === "") i += 1;
  const open = i < lines.length ? parseTagLine(lines[i]!.trim()) : null;
  if (
    open === null ||
    !open.ok ||
    open.tag.name !== META_TAG ||
    open.tag.selfClosing
  ) {
    return { ok: true, meta: null, header: "", rest: markdown };
  }
  const start = i;
  const meta: ParsedPageMeta = {
    attrs: open.tag.attrs,
    breadcrumb: [],
    backlinks: [],
    tags: null,
  };
  // The section the next line belongs to, if one is open.
  let section: PageListTag | typeof TAGS_TAG | null = null;
  const seen = new Set<string>();
  // `meta.tags` once a `<tags>` section opens.
  const tagList: PageMetaTag[] = [];
  for (i += 1; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (line === `</${META_TAG}>`) {
      if (section !== null) {
        return refusal(`<${section}> is not closed before </${META_TAG}>`);
      }
      let next = i + 1;
      if (next < lines.length && lines[next] === "") next += 1;
      return {
        ok: true,
        meta,
        header: lines.slice(start, next).join("\n"),
        rest: lines.slice(next).join("\n"),
      };
    }
    // The header is one block of lines: a blank line inside it means its close
    // went missing, which names the fix better than "unknown line".
    if (line === "") {
      return refusal(
        `it has no closing </${META_TAG}> line before a blank line`,
      );
    }
    if (section !== null && line === `</${section}>`) {
      section = null;
      continue;
    }
    const tag = parseTagLine(line);
    if (
      tag.ok &&
      section === null &&
      (isPageListTag(tag.tag.name) || tag.tag.name === TAGS_TAG)
    ) {
      if (seen.has(tag.tag.name)) {
        return refusal(`<${tag.tag.name}> appears twice`);
      }
      seen.add(tag.tag.name);
      if (tag.tag.name === TAGS_TAG) meta.tags = tagList;
      if (!tag.tag.selfClosing) section = tag.tag.name;
      continue;
    }
    if (
      tag.ok &&
      section === TAGS_TAG &&
      tag.tag.name === TAG_LINE &&
      tag.tag.selfClosing
    ) {
      const read = tagOfLine(tag.tag.attrs);
      if (!read.ok) return refusal(read.why);
      tagList.push(read.tag);
      continue;
    }
    if (
      tag.ok &&
      section !== null &&
      section !== TAGS_TAG &&
      tag.tag.name === CRUMB_TAG &&
      tag.tag.selfClosing
    ) {
      meta[PAGE_LIST_KEY[section]].push({
        id: tag.tag.attrs.id ?? "",
        title: tag.tag.attrs.title ?? "",
      });
      continue;
    }
    return refusal(
      `it holds the line ${JSON.stringify(lines[i])}, which is not part of a ` +
        `<${META_TAG}> header`,
    );
  }
  return refusal(`it has no closing </${META_TAG}> line`);
}

function refusal(why: string): PageMetaSplit {
  return {
    ok: false,
    reason:
      `the document opens with a <${META_TAG}> header, but ${why}. Only its ` +
      `<${TAGS_TAG}> section is writable, one <${TAG_LINE} name="…"/> line per ` +
      `tag; hand the rest back exactly as read_page showed it, or leave the ` +
      `header out, and write your content below it`,
  };
}
