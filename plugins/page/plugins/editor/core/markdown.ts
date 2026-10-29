// Markdown ⇄ block-forest, orchestrated generically from per-block-type metadata.
//
// This is the PURE central orchestrator: it never names a specific block type.
// Each block type owns how it maps to/from markdown, either explicitly (a
// `markdown` declaration on its `defineBlock` handle) or by derivation from its
// text lens + `markdownPrefixes`. Adding a block type extends clipboard markdown
// automatically. Parameterized on a `MarkdownContext` (not a slot import) so it
// stays a leaf both runtimes can call — the web `Editor.Block` contributions and
// any future server-side markdown import/export.
//
// Used for clipboard interop: pasting external markdown (bullets, task lists,
// fenced code, indentation→nesting) becomes a `SerializedBlock[]`; copying blocks
// emits markdown as the `text/plain` representation.
//
// Pure module (no React, no DB): unit-tested directly in `./markdown.test.ts`.

import { plainOf, runsOf, type RichText } from "./rich-text";
import {
  parseInlineMarkdown,
  serializeInlineMarkdown,
  type SoftBreaks,
} from "./inline-markdown";
import type { BlockHandle } from "./define-block";
import type { SerializedBlock } from "./serialized-block";

// ---------------------------------------------------------------------------
// The conversion context
// ---------------------------------------------------------------------------

/**
 * Everything the conversion needs that is NOT a block's own business.
 *
 * `protectedSpans` is REQUIRED, not optional, and that is the whole point: the
 * inline decorator tokens (`[[page:…]]`, `[[date:…]]`, `\(latex\)`) live as
 * plain substrings inside `TextRun.text`, so a marks-aware scan that does not
 * know about them corrupts inline LaTeX — which is full of `_` and `*`. An
 * optional parameter is one a caller can silently forget; a required one makes
 * "I have no tokens" an explicit `[]`.
 *
 * `blankLines` is required for the same shape of reason, over a different
 * asymmetry: a blank line means an empty paragraph in the markdown this codebase
 * EMITS and a paragraph separator in the markdown a user PASTES, and nothing
 * about the text tells the two apart — only the caller knows which document it
 * is holding. A default would silently pick one, and both wrong answers are
 * documents nobody wrote: an empty paragraph sprayed between every two
 * paragraphs of a pasted README, or every spacer dropped out of our own round
 * trip.
 */
export interface MarkdownContext {
  handles: BlockHandle<unknown>[];
  /** Spans that must survive verbatim: no delimiter may open or close inside one. */
  protectedSpans: RegExp[];
  /**
   * `"empty-block"` — a blank line is an empty block of the default-text type,
   * landing as the previous sibling of the block that follows it.
   * `"separator"` — blank lines are skipped, which is correct CommonMark and
   * the lenient half of the paste contract.
   *
   * Read on PARSE only: there is one emitted form for everybody, so the
   * serializer never asks.
   */
  blankLines: "empty-block" | "separator";
  /**
   * How an empty block is EMITTED when a blank line cannot state its position.
   *
   * `"blank-line"` — always a blank line. Honest for a HUMAN reading the text
   * (a paste into another app must never grow a tag), and lossy in exactly the
   * three places the parser's own blank-line rules cannot reach: a blank line
   * carries no indentation of its own, so it lands at the depth of the block
   * that follows it and a leading or trailing blank run is dropped outright.
   * `"pinned"` — those three positions (a node with children, the first of its
   * sibling list, the last of it) emit the handle's TAG form instead, so the
   * round trip is exact — and so does a fourth, beside a tag line, so a read
   * never holds a blank line there (see {@link dropBlankLinesBesideTags}). A
   * handle whose type maps to no tag keeps the blank
   * line and keeps the loss: the pin never invents a spelling.
   *
   * Required for the same reason `blankLines` is, over the other direction of
   * the same asymmetry: only the caller knows whether the document it is about
   * to produce will be read back by this codebase (where exactness is the whole
   * contract) or by a person in another app (where a tag is noise).
   */
  emptyBlocks: "pinned" | "blank-line";
  /**
   * How a SOFT LINE BREAK inside a block's text is emitted.
   *
   * `"escaped"` — the two characters `\n`, so the block stays on ONE markdown
   * line and the round trip is exact. `"newline"` — a real newline, which a
   * person pasting into another app has to see, and which this codebase then
   * cannot read back as one block: the document splits on `\n`, so one block
   * comes back as several siblings at its own indent.
   *
   * Required, and for the third time the same reason `blankLines` and
   * `emptyBlocks` are: only the caller knows which of those two readers its
   * document is for, so there is no safe default and a call site that does not
   * say is a tsc error. Read on SERIALIZE only — the parse side decodes `\n`
   * in both dialects, since what we emit has to read back (see THE ESCAPING
   * RULE in `inline-markdown.ts`).
   */
  softBreaks: SoftBreaks;
}

/**
 * The node shape the SERIALIZE walk reads. Deliberately wider than
 * `SerializedBlock`: a `<page id="…"/>` tag cannot be produced from an id-less
 * node, because a sub-page's identity IS its row id. `IdentifiedBlock` satisfies
 * this exactly; `SerializedBlock` satisfies it with `id: undefined`, and a type
 * whose tag needs the id fails LOUDLY rather than emitting an id-less tag.
 */
export interface MarkdownNode {
  type: string;
  data?: unknown;
  expanded: boolean;
  /** Row id, when the caller has one. Reaches a type's `tag.attrs` as `ctx.id`. */
  id?: string;
  /**
   * Values for this node's tag's {@link BlockTag.annotated} attributes — facts
   * about the row that live OUTSIDE its `data`, supplied by whoever ran the walk
   * (see there).
   *
   * Same optionality story as {@link MarkdownNode.id}: a forest carrying none is
   * the CLIPBOARD, and it must still serialize. A name the tag never declared is
   * a loud failure at serialize, never a silent drop.
   */
  annotations?: Readonly<Record<string, string>>;
  children: MarkdownNode[];
}

// ---------------------------------------------------------------------------
// Per-type markdown contract (typed against each block's own inferred data)
// ---------------------------------------------------------------------------

export interface MdSerializeCtx {
  /**
   * Render runs (or a legacy string) as inline markdown: marks as delimiters,
   * links, colors, underline, with literal delimiter characters escaped and a
   * soft break spelled per the context's dialect. THE default renderer for a
   * block's text — `serializeInlineMarkdown` under the hood, bound to the
   * context's `protectedSpans` and `softBreaks`.
   */
  md(text: RichText | string): string;
  /**
   * {@link md} forced into the ESCAPED soft-break dialect, whatever the
   * context's own: a soft break is always the two characters `\n`. For a
   * block whose syntax needs a run to stay on ONE line in every dialect — a
   * table cell, where a real newline would end the row. `md` alone would emit
   * one in the clipboard dialect.
   */
  mdLine(text: RichText | string): string;
  /**
   * The conversion's protected spans ({@link MarkdownContext.protectedSpans}):
   * the inline decorator tokens whose bytes must survive verbatim. For a block
   * whose OWN syntax splits a line (a table's `|` cell separators), so it can
   * refuse to split inside `\(a|b\)` or a `[[page:…]]` token.
   */
  protectedSpans: RegExp[];
  /**
   * Flatten runs (or a legacy string) to plain text, dropping marks and escaping
   * nothing. The raw escape hatch, for a block type whose syntax is not inline
   * markdown at all (a fenced body, a LaTeX expression).
   */
  plain(text: RichText | string): string;
  /** 1-based position within this block's consecutive same-type sibling run. */
  ordinal: number;
  /**
   * The node's row id, when the walk's input carried one (`MarkdownNode.id`).
   * Undefined for an id-less `SerializedBlock` forest, and the two tag kinds
   * that read it answer that differently ON PURPOSE: a tag that NEEDS the id
   * (`page`) throws rather than emitting an identity-less pointer, while an
   * {@link BlockTag.identified} tag simply omits the attribute — see there.
   */
  id?: string;
  /**
   * The node's externally-owned attribute values, when the walk's input carried
   * them ({@link MarkdownNode.annotations}). Only names the tag declared in
   * {@link BlockTag.annotated} may appear here — one it did not is a loud
   * failure, because an attribute the tag does not reserve comes back on parse
   * as a `data` key.
   */
  annotations?: Readonly<Record<string, string>>;
}

export interface MdParseCtx {
  /** Parse inline markdown (marks, links, colors) into canonical runs. */
  runs(text: string): RichText;
  /**
   * The conversion's protected spans — the parse twin of
   * {@link MdSerializeCtx.protectedSpans}, for a block that splits a line
   * before handing its pieces to {@link runs}.
   */
  protectedSpans: RegExp[];
}

/**
 * What lives between a tag's `<open>` and `</close>`.
 *
 * - `"children"` — the block's children, indented one level (containers). The
 *   walk must NOT re-emit them afterwards.
 * - `"children-when-expanded"` — children only when `node.expanded`; collapsed
 *   emits the self-closing form. Declared, never derived from
 *   `handle.collapsible === "always"`: that flag's set includes `toggle`, which
 *   must keep emitting its children folded (markdown ignores the fold — see the
 *   editor's CLAUDE.md). Every OTHER body mode ignores `expanded` entirely.
 * - `"text"` — the block's own text, from its text lens, inside the tag. For a
 *   text-bearing type whose canonical prefix is taken (`quote`, whose `> ` the
 *   `toggle` owns) or which has none at all (`prompt`), so it cannot round-trip
 *   as a bare paragraph. Children still nest by indentation, as for any text
 *   block.
 * - `"none"` — always self-closing. A body on PARSE is a loud rejection, never a
 *   silent drop.
 */
export type BlockTagBody =
  "children" | "children-when-expanded" | "text" | "none";

/**
 * A tag-delimited markdown region for one block type: `<name attrs>…</name>`.
 *
 * This is what makes markdown coverage TOTAL. `parseLine` is single-line and a
 * `fence` body is an opaque string, so neither can produce CHILDREN; and a type
 * with neither a text lens nor an explicit `serialize` used to emit a BLANK LINE
 * — nine types (callout, page, page-link, image, video, audio, file, embed,
 * bookmark) silently deleted on every round trip. The tag is now that fallback,
 * and every field below has a DEFAULT derived from the schema, so a block type
 * is covered the day it is defined rather than the day someone remembers
 * markdown.
 */
export interface BlockTag<T> {
  /** Tag name. Defaults to the handle's `type`. */
  name?: string;
  /**
   * Attributes for the open tag. Defaults to the derived projection: every
   * STRING field of `data` becomes a plain attribute and everything else
   * (numbers, booleans, `null`, objects, arrays) is JSON-encoded into a single
   * `data` attribute.
   *
   * Only strings are plain attributes because an attribute value is a string
   * both ways: emitting `width="640"` would read back as the string `"640"`,
   * indistinguishable from a genuinely-string field, so the projection would be
   * lossy exactly where it claims not to be. Declare `attrs` (with a matching
   * `parseAttrs`) to get a prettier form for a specific type.
   */
  attrs?(
    data: T,
    ctx: MdSerializeCtx,
  ): Record<string, string | number | boolean | null | undefined>;
  /**
   * Rebuild this type's data from the parsed attributes. Defaults to the inverse
   * of the derived projection, finished with the handle's own `schema.parse`, so
   * malformed attributes are a LOUD zod error rather than a row the write
   * boundary 400s on later. For `body: "text"` the text comes from the BODY and
   * overwrites whatever this returns for `text`.
   */
  parseAttrs?(attrs: Record<string, string>, ctx: MdParseCtx): T;
  /** Defaults to `"children"` — which is also what the derived void fallback uses. */
  body?: BlockTagBody;
  /**
   * This tag carries its row id as the reserved `id` attribute, in BOTH
   * directions: serialize emits `ctx.id` as the FIRST attribute, and parse lifts
   * it back OFF the attribute record onto `SerializedBlock.ref` — never into
   * `data`. That is what "reserved" means, and why `resolveTag` refuses a handle
   * that declares this alongside an `id` field of its own: the derived
   * projection would emit `data.id` under the same name and the two meanings
   * would fight.
   *
   * What it buys is an ADDRESSABLE region. A reader of the emitted markdown
   * (a human, or an agent through `read_page`) gets an anchor it can hand back
   * in an edit, and the applier resolves that anchor to the row it names
   * instead of inferring identity from content similarity.
   *
   * **An id-less forest omits the attribute and is not an error.** That is the
   * deliberate difference from `page`, whose own `attrs` throws without an id: a
   * sub-page's identity IS its row, so an id-less `<page/>` would point at
   * nothing, whereas an id-less `<agent-note>` is the ordinary clipboard case
   * (copying a card out of a page must stay portable markdown) and also what a
   * document says when it wants a card MINTED.
   */
  identified?: true;
  /**
   * This tag only ever POINTS at an existing row: a parse of it without its
   * reserved `id` — the tagless form, which is how a document asks for a row to
   * be MINTED — is refused loudly, with `reason` appended to the message.
   * Requires {@link identified} (without an id attribute there is nothing to
   * point with), and resolution refuses the pair otherwise.
   *
   * It exists for a row kind only a person may create, while an agent must still
   * be able to echo a pointer at one back through markdown: `page`'s
   * `<instructions-page>` spelling (the human's standing instructions to agents).
   * `serializeOnly` would be the wrong tool — it gives up the name on parse, so
   * the echoed pointer would not read back at all.
   */
  pointerOnly?: { reason: string };
  /**
   * Attribute names this tag carries whose values are supplied from OUTSIDE the
   * block's `data`, reserved in BOTH directions. It is the generalization of
   * {@link identified}, whose reserved `id` is the one such name the walk itself
   * can produce.
   *
   * The fact it exists for: some things a reader of a block needs to know are
   * not the block's to store. A TODO card's linked task, and that task's status,
   * live in another table keyed by the block id — so neither the derived
   * attribute projection (which reads `data`) nor a declared `attrs(data, ctx)`
   * can produce them, and putting them in `data` would make the block's own row
   * a second, drifting copy of somebody else's record. They are handed to the
   * SERIALIZE walk instead ({@link MarkdownNode.annotations} →
   * {@link MdSerializeCtx.annotations}) and emitted here, after the reserved
   * `id` and before the type's own attrs.
   *
   * **These attributes are READ-ONLY, and parse DISCARDS them.** The parser is
   * pure: it can neither tell a value an agent edited from the one it emitted a
   * minute ago, nor write the table that owns it. So an agent that edits
   * `status="done"` in a document has that edit ignored — stated by the tool
   * that hands out the document, never silently absorbed. What parse must still
   * do is take the names OFF the attribute record before the handle's schema
   * sees them; see `claimTag`.
   *
   * **An absent value omits the attribute** rather than emitting an empty one —
   * the same rule {@link identified} follows for an id-less forest, and for the
   * same reason: a TODO nobody has dispatched simply has no task, and a forest
   * on the clipboard has no annotations at all.
   */
  annotated?: readonly string[];
  /**
   * This tag is emitted but never CLAIMED on parse: another handle owns the name
   * on the parse side. The one case is `page`'s PRIMARY spelling — `<page
   * id="x"/>` is also how a link-to-page block writes itself, so `page-link`
   * claims the name and a bare `<page/>` parses as a pointer at a page, never as
   * a sub-page. Two handles claiming one name where neither declares this is a
   * loud error.
   *
   * It governs the primary spelling only: a {@link spellings} entry is always
   * claimed, because being parseable is the whole reason a second spelling
   * exists.
   */
  serializeOnly?: true;
  /**
   * Further spellings of this SAME block type, each selected by the row's data —
   * `page` is written `<page id/>` for a human's sub-page and `<agent-page id
   * title/>` for an agent-authored one, and both are one `type="page"` row.
   *
   * Each spelling's {@link BlockTagSpelling.data} is a PRESET of discriminator
   * values, and that one object does both jobs, so the two directions cannot
   * disagree:
   *
   * - **serialize** — a row whose data carries every preset value is written
   *   under that spelling's name (and with that spelling's options); a row that
   *   matches none is written under the primary tag above;
   * - **parse** — the preset is merged OVER whatever the attributes parsed to,
   *   so the name alone is what says it, and an attribute cannot contradict it.
   *
   * Round-trip correctness is then asserted rather than hoped for: a parse that
   * produces data selecting a DIFFERENT spelling than the tag it came in under
   * throws (see `tagsFor`). Resolution refuses a duplicate name, an empty preset
   * (it would select every row, shadowing the primary), a preset key the schema
   * does not declare, and a preset value that is not a discriminator literal.
   */
  spellings?: readonly BlockTagSpelling<T>[];
}

/**
 * One data-selected spelling of a block type's tag — see
 * {@link BlockTag.spellings}. It carries every option a tag does (its own
 * `attrs`, `parseAttrs`, `body`, `identified`, `annotated`), because a spelling
 * is a different WRITING of the row and may need a different one of each; what
 * it cannot say is `serializeOnly` (a spelling exists to be parsed) or nest
 * spellings of its own.
 */
export type BlockTagSpelling<T> = Omit<
  BlockTag<T>,
  "name" | "serializeOnly" | "spellings"
> & {
  /** The tag name. Required: a spelling with the primary's name is refused. */
  name: string;
  /**
   * The discriminator values this spelling is selected by, and the preset its
   * parse merges over the attributes. String / number / boolean / `null` only —
   * a discriminator is a literal, and `===` is then the whole comparison.
   */
  data: Partial<T>;
};

export interface BlockMarkdown<T> {
  /**
   * Emit this block as markdown line(s), with NO indentation — the central walk
   * indents (including splitting multi-line output). Default for text-bearing
   * types: `outputPrefix + ctx.md(text)`.
   */
  serialize?(data: T, ctx: MdSerializeCtx): string;
  /**
   * Claim one line → this type's data payload, or `null` to decline. Default for
   * text-bearing types: a `markdownPrefixes` match → `{ ...empty(), text: runs }`.
   *
   * `claims` is why this is a PAIR rather than a bare function. A hand-written
   * `parse` is a closure, and nothing outside it can enumerate the lines it
   * takes — a `markdownPrefixes` claimer IS its own declaration (`prefix + "x"`
   * is a sample of it), but `/^\d+[.)]\s+(.*)$/` says nothing to anybody but the
   * regex engine. So the samples are the declaration: the escape check reads
   * them to assert one leading backslash really defeats this claimer, and the
   * round-trip generator reads them to produce paragraphs that open like a
   * claimed line. Required rather than optional, because a declaration a caller
   * may omit is one nobody writes.
   *
   * What it does NOT buy, so nobody over-reads it: samples make a claim
   * *declared*, never *complete*. A regex claiming more lines than its samples
   * name is still possible — a closure's language cannot be enumerated — so a
   * check over them covers what was declared and nothing else.
   */
  parseLine?: {
    /** Lines this claimer takes. At least one; each must really be claimed by it. */
    claims: readonly string[];
    parse(line: string, ctx: MdParseCtx): T | null;
  };
  /** Fenced multi-line: the walk accumulates open→close, then calls `parseFenced`. */
  fence?: {
    open: string;
    close: string;
    parseFenced(info: string, body: string, ctx: MdParseCtx): T;
  };
  /**
   * A RUN of consecutive lines with no closing delimiter — a GFM table, whose
   * rows simply stop. Neither `parseLine` (one line) nor `fence` (open…close)
   * can say that.
   *
   * The walk collects the lines that follow the first one at the SAME indent,
   * non-blank, each `matches`-ing on its own (a deeper line is a child, never a
   * continuation), and hands them to `parse`, which takes the LONGEST prefix it
   * accepts and says how many lines that was. The walk then continues on the
   * rest of the run, so one run can hold several blocks back to back. `null`
   * DECLINES: the first line falls to prose (and re-serializes escaped —
   * lenient parse, canonical serialize).
   *
   * Line-local on purpose. `matches` is the whole of this claim as far as the
   * claim authority is concerned — the serializer's escape asks "who would take
   * this ONE line", and a predicate over one line answers it exactly. A
   * declaration that needed the next line to decide would not be escapable.
   *
   * Every line `serialize` emits must `matches` (asserted in our own dialect):
   * a line that did not would end the run early and come back as a sibling.
   */
  lineRun?: {
    /**
     * Sample FIRST lines this claimer takes — the same declaration
     * `parseLine.claims` is, read by the same escape check. At least one.
     */
    claims: readonly string[];
    /** Does this ONE line belong to a run? Probed a line at a time. */
    matches(line: string): boolean;
    /**
     * Parse the longest accepted PREFIX of `lines` (dedented, all `matches`),
     * reporting how many it consumed (at least 1); `null` ⇒ decline.
     */
    parse(
      lines: readonly string[],
      ctx: MdParseCtx,
    ): { data: T; consumed: number } | null;
  };
  /**
   * `parseLine` dispatch order (desc) — only to disambiguate overlapping prefixes
   * (e.g. to-do beats bulleted-list for `- [ ] x`). Default 0; ties keep
   * registration order.
   */
  precedence?: number;
  /**
   * Tag-delimited region — the ONLY mapping that can carry children, and the
   * default for a type with neither a text lens nor a `serialize`. Declaring it
   * beside a `serialize` makes it PARSE-only for that type: `serialize` wins on
   * the way out, which is how `page/text` emits a BLANK LINE for an empty
   * paragraph while `<text/>` keeps parsing back into one — the spelling every
   * document written before the blank-line dialect uses, and the way to write an
   * empty block whose position that dialect cannot express.
   */
  tag?: BlockTag<T>;
}

type Handle = BlockHandle<unknown>;

/**
 * The parse context for one conversion. Built PER CALL rather than as a module
 * constant, because `runs` now closes over the context's `protectedSpans`.
 */
function parseCtxFor(ctx: MarkdownContext): MdParseCtx {
  return {
    runs: (text) => parseInlineMarkdown(text, ctx.protectedSpans),
    protectedSpans: ctx.protectedSpans,
  };
}

// ---------------------------------------------------------------------------
// Default-text handle
// ---------------------------------------------------------------------------

/**
 * THE plain-paragraph block type, selected by its own `defaultText` declaration
 * — never inferred from the absence of other traits. Undefined only when the
 * composition ships no such block type at all; every caller treats that as
 * "nothing to create" rather than substituting an arbitrary type.
 */
export function defaultTextHandle(handles: Handle[]): Handle | undefined {
  return handles.find((h) => h.defaultText);
}

// ---------------------------------------------------------------------------
// Generic resolution (derives serialize/parse from the lens + prefixes)
// ---------------------------------------------------------------------------

/**
 * The CANONICAL markdown prefix this type emits: the first `markdownPrefixes`
 * entry (the rest are parse-only aliases), else "".
 *
 * It reads the field whole. It used to skip entries starting with a backtick or
 * `[` — a substring sniff standing in for "that one isn't really markdown
 * syntax", which was true (a code fence, a to-do's `[] ` typing trigger) but
 * unstated: those prefixes now live on `typingPrefixes`, which this side never
 * sees, so the sniff has nothing left to catch.
 */
function outputPrefix(h: Handle): string {
  return h.markdownPrefixes?.[0] ?? "";
}

/**
 * Derived parse prefixes for a text-bearing handle, sorted longest-first so a
 * more specific marker wins. Every `markdownPrefixes` entry is claimable by
 * construction — the field means markdown line syntax and nothing else.
 */
function derivedParsePrefixes(h: Handle): string[] {
  return [...(h.markdownPrefixes ?? [])].sort((a, b) => b.length - a.length);
}

// ---------------------------------------------------------------------------
// Tags: resolution, attribute encoding
// ---------------------------------------------------------------------------

/** A `BlockTag` spelling with every default filled in, bound to its handle. */
interface ResolvedTag {
  handle: Handle;
  name: string;
  body: BlockTagBody;
  attrsOf(data: unknown, ctx: MdSerializeCtx): Record<string, string>;
  /** `inner` is the tag's body text — only ever supplied for `body: "text"`. */
  dataOf(
    attrs: Record<string, string>,
    inner: string | null,
    ctx: MdParseCtx,
  ): unknown;
  serializeOnly: boolean;
  /** The reserved `id` attribute is this tag's row ref — see {@link BlockTag.identified}. */
  identified: boolean;
  /** Why an id-less parse of this tag is refused, or null — see {@link BlockTag.pointerOnly}. */
  pointerOnly: string | null;
  /**
   * Attribute names supplied from outside `data`, reserved both ways — see
   * {@link BlockTag.annotated}. Empty for a tag that declares none, so both the
   * emit and the strip are unconditional loops rather than a branch.
   */
  annotated: readonly string[];
  /**
   * The discriminator values that select this spelling — `null` for the PRIMARY
   * spelling, which is what a row matching no preset is written under. See
   * {@link BlockTag.spellings}.
   */
  preset: Readonly<Record<string, unknown>> | null;
}

/**
 * Every spelling of one handle's tag: the primary, and the data-selected ones
 * (possibly none). `select` is THE spelling choice for a row's data — the
 * serializer asks it which tag to write, and every parse asks it back to prove
 * it landed on the spelling it came in under.
 */
interface ResolvedTags {
  primary: ResolvedTag;
  spellings: readonly ResolvedTag[];
  select(data: unknown): ResolvedTag;
}

/** Attribute names that survive as PLAIN attributes; anything else is JSON'd. */
const ATTR_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * The derived attribute projection — see `BlockTag.attrs`. Non-string values and
 * keys that are not legal attribute names go into one JSON `data` attribute, so
 * the projection is lossless for ANY schema without the type declaring anything.
 *
 * `omit` is a spelling's preset keys: the tag NAME already says them, and the
 * parse merges the preset back over whatever the attributes carried.
 */
function derivedAttrs(
  data: unknown,
  body: BlockTagBody,
  omit: ReadonlySet<string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (data === undefined || data === null) return out;
  if (typeof data !== "object" || Array.isArray(data)) {
    out.data = JSON.stringify(data);
    return out;
  }
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || omit.has(key)) continue;
    // A `"text"` body carries the text between the tags; keeping it here too
    // would emit it twice and make the two copies drift.
    if (body === "text" && key === "text") continue;
    if (typeof value === "string" && ATTR_NAME.test(key) && key !== "data")
      out[key] = value;
    else rest[key] = value;
  }
  if (Object.keys(rest).length > 0) out.data = JSON.stringify(rest);
  return out;
}

/**
 * The exact inverse of {@link derivedAttrs}, finished with the handle's schema —
 * after a spelling's preset is merged over what the attributes carried.
 */
function derivedTagData(
  h: Handle,
  attrs: Record<string, string>,
  inner: string | null,
  ctx: MdParseCtx,
  body: BlockTagBody,
  preset: Readonly<Record<string, unknown>> | null,
): unknown {
  const raw: Record<string, unknown> = {};
  const blob = attrs.data;
  if (blob !== undefined) {
    const decoded: unknown = JSON.parse(blob);
    if (
      decoded !== null &&
      typeof decoded === "object" &&
      !Array.isArray(decoded)
    ) {
      Object.assign(raw, decoded);
    } else {
      // A non-object payload was the WHOLE `data` — there is nothing to merge it
      // with (`derivedAttrs` emits no other attribute in that case).
      return h.parse(decoded);
    }
  }
  for (const [key, value] of Object.entries(attrs)) {
    if (key !== "data") raw[key] = value;
  }
  if (body === "text") raw.text = ctx.runs(inner ?? "");
  return h.parse(preset ? { ...raw, ...preset } : raw);
}

/**
 * Resolve ONE spelling's options against its handle, validating what can only
 * be validated against the schema. `preset` is `null` for the primary spelling.
 */
function resolveTag(
  h: Handle,
  spec: Omit<BlockTag<unknown>, "spellings">,
  name: string,
  preset: Readonly<Record<string, unknown>> | null,
): ResolvedTag {
  const body = spec.body ?? "children";
  if (body === "text" && !h.text) {
    throw new Error(
      `defineBlock("${h.type}"): markdown.tag.body = "text" on <${name}> needs a text lens — ` +
        "this block type's schema declares no `text`, so there is no body to emit.",
    );
  }
  if (spec.identified === true && "id" in h.schema.shape) {
    throw new Error(
      `defineBlock("${h.type}"): markdown.tag.identified reserves the \`id\` attribute for the ` +
        "block's ROW id, but this type's schema declares an `id` field of its own. The derived " +
        "attribute projection would emit `data.id` under that same name, so the two meanings " +
        "would fight — a parse would either lift a payload id into the row ref or overwrite the " +
        "row ref with the payload's. Rename the schema field; the attribute name is reserved.",
    );
  }
  if (spec.pointerOnly !== undefined && spec.identified !== true) {
    throw new Error(
      `defineBlock("${h.type}"): markdown.tag.pointerOnly on <${name}> needs \`identified\` — ` +
        "a tag that carries no row id has nothing to point with, so every parse of it would be refused.",
    );
  }
  const annotated = spec.annotated ?? [];
  for (const annotation of annotated) {
    // Each of the three is a name that ALREADY has a meaning on this tag, so
    // emitting an annotation under it would produce one attribute standing for
    // two things and parse would have to guess which. Caught at resolution —
    // the first time anything serializes or parses this type — rather than on
    // the one document where both values happen to be present.
    //
    // A schema field clashes only when the DERIVED projection is in use, since
    // that is what would emit it. A tag declaring its own `attrs` chooses what
    // it emits, and `tagAttrs` catches a declared `attrs` emitting a reserved
    // name at serialize — which is how `page` reserves `title`, a field of its
    // own schema, for the value a reader supplies: its declared `attrs` emits
    // only the id.
    const clash =
      annotation in h.schema.shape && spec.attrs === undefined
        ? "this type's schema declares a field of its own under that name, which the derived " +
          "attribute projection emits"
        : annotation === "data"
          ? "`data` is the attribute the derived projection JSON-encodes everything non-string into"
          : spec.identified === true && annotation === "id"
            ? "`id` is already reserved by `markdown.tag.identified` for the block's ROW id"
            : null;
    if (clash !== null) {
      throw new Error(
        `defineBlock("${h.type}"): markdown.tag.annotated reserves the \`${annotation}\` attribute ` +
          `on <${name}> for a value supplied from OUTSIDE this block's data, but ${clash}. The ` +
          "two meanings would fight over one attribute — rename one of them; the annotated name " +
          "is reserved.",
      );
    }
  }
  const attrs = spec.attrs;
  const parseAttrs = spec.parseAttrs;
  const omit = new Set(Object.keys(preset ?? {}));
  return {
    handle: h,
    name,
    body,
    attrsOf: attrs
      ? (data, ctx) => encodeAttrs(attrs(data, ctx))
      : (data) => derivedAttrs(data, body, omit),
    dataOf: parseAttrs
      ? (a, inner, ctx) => {
          const parsed = parseAttrs(a, ctx);
          const data =
            body === "text"
              ? {
                  ...(parsed as Record<string, unknown>),
                  text: ctx.runs(inner ?? ""),
                }
              : parsed;
          // A spelling's preset is part of what the name MEANS, so it lands over
          // whatever the declared parser returned — and the result is finished
          // with the schema, since the merge is a payload the parser never saw.
          return preset
            ? h.parse({ ...(data as Record<string, unknown>), ...preset })
            : data;
        }
      : (a, inner, ctx) => derivedTagData(h, a, inner, ctx, body, preset),
    serializeOnly: preset === null && spec.serializeOnly === true,
    identified: spec.identified === true,
    pointerOnly: spec.pointerOnly?.reason ?? null,
    annotated,
    preset,
  };
}

/** Does `data` carry every one of `preset`'s discriminator values? */
function presetMatches(
  preset: Readonly<Record<string, unknown>>,
  data: unknown,
): boolean {
  if (data === null || typeof data !== "object") return false;
  const record = data as Record<string, unknown>;
  return Object.entries(preset).every(([key, value]) => record[key] === value);
}

/**
 * Every spelling of `h`'s tag, validated and bound — see {@link BlockTag.spellings}.
 *
 * The refusals are the ones that would otherwise surface as a document that
 * cannot read back: a duplicate name (two spellings one parse cannot tell
 * apart), an empty preset (it selects every row, so the primary would never be
 * written), a key the schema does not declare (a preset nothing can store), and
 * a non-literal value (a discriminator is compared with `===`).
 *
 * When there ARE spellings, every parse is wrapped in the round-trip assertion:
 * the data a tag parses to must select that same tag. A primary parse landing on
 * a spelling — an agent writing `<page data='{"author":"agent"}'/>`-shaped
 * attributes onto a claimable primary — or a spelling whose own `parseAttrs`
 * contradicts its preset is a loud error at the parse, never a row that
 * serializes back under a different name.
 */
function tagsFor(h: Handle): ResolvedTags | null {
  const spec = h.markdown?.tag;
  const declared: BlockTag<unknown> | null = spec
    ? (spec as BlockTag<unknown>)
    : h.markdown?.serialize || h.text
      ? null
      : {};
  if (declared === null) return null;

  const primary = resolveTag(h, declared, declared.name ?? h.type, null);
  const seen = new Set([primary.name]);
  const spellings = (declared.spellings ?? []).map((s) => {
    if (seen.has(s.name)) {
      throw new Error(
        `defineBlock("${h.type}"): markdown.tag.spellings names <${s.name}> twice (or reuses the ` +
          "primary tag's name). One name is one spelling — a parse could not tell them apart.",
      );
    }
    seen.add(s.name);
    const preset = s.data as Record<string, unknown>;
    const keys = Object.keys(preset);
    if (keys.length === 0) {
      throw new Error(
        `defineBlock("${h.type}"): markdown.tag.spellings <${s.name}> has an EMPTY preset, which ` +
          "selects every row — the primary spelling would never be written. A spelling is " +
          "chosen by the discriminator values it presets.",
      );
    }
    for (const key of keys) {
      if (!(key in h.schema.shape)) {
        throw new Error(
          `defineBlock("${h.type}"): markdown.tag.spellings <${s.name}> presets \`${key}\`, which ` +
            "this type's schema does not declare — a row could never carry it, so the spelling " +
            "could never be written, and its parse would be refused by the schema.",
        );
      }
      const value = preset[key];
      if (
        value !== null &&
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean"
      ) {
        throw new Error(
          `defineBlock("${h.type}"): markdown.tag.spellings <${s.name}> presets \`${key}\` to a ` +
            "non-literal value. A spelling is selected by DISCRIMINATOR values, compared with " +
            "`===`: a string, number, boolean or null.",
        );
      }
    }
    return resolveTag(h, s, s.name, preset);
  });

  const select = (data: unknown): ResolvedTag => {
    const matching = spellings.filter((s) => presetMatches(s.preset!, data));
    if (matching.length > 1) {
      throw new Error(
        `markdown: a "${h.type}" row matches several spellings (${matching
          .map((s) => `<${s.name}>`)
          .join(
            ", ",
          )}). Their presets overlap, so which tag the row is written under ` +
          "would depend on declaration order.",
      );
    }
    return matching[0] ?? primary;
  };
  if (spellings.length === 0) return { primary, spellings, select };

  const asserted = (tag: ResolvedTag): ResolvedTag => ({
    ...tag,
    dataOf: (a, inner, ctx) => {
      const data = tag.dataOf(a, inner, ctx);
      const landed = select(data);
      if (landed !== tag) {
        throw new Error(
          `markdown: <${tag.name}> parsed to a "${h.type}" payload that is written as ` +
            `<${landed.name}>. A spelling is chosen by its data, so a tag whose attributes ` +
            "contradict its own name cannot read back — write the other tag instead.",
        );
      }
      return data;
    },
  });
  const boundPrimary = asserted(primary);
  const boundSpellings = spellings.map(asserted);
  // `select` must hand out the ASSERTED objects, so identity comparisons
  // against a spelling looked up by name keep holding.
  const byName = new Map(
    [boundPrimary, ...boundSpellings].map((t) => [t.name, t] as const),
  );
  return {
    primary: boundPrimary,
    spellings: boundSpellings,
    select: (data) => byName.get(select(data).name)!,
  };
}

/** Drop absent attributes and stringify the rest (a declared `attrs`' output). */
function encodeAttrs(
  attrs: Record<string, string | number | boolean | null | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    out[key] = typeof value === "string" ? value : String(value);
  }
  return out;
}

/**
 * The tag a row of this handle is written under, or `null` when the type maps
 * to LINES instead.
 *
 * Order matters and is the whole coverage rule: an explicitly declared `tag`
 * always wins (even beside a `serialize`, which then owns only the way out); a
 * text-bearing type keeps its derived `prefix + text` line; and a type with
 * NEITHER falls back to the derived tag — the branch that used to emit `""`.
 * Which SPELLING of that tag is the row's data's choice — see
 * {@link BlockTag.spellings}.
 */
function tagForData(h: Handle, data: unknown): ResolvedTag | null {
  return tagsFor(h)?.select(data) ?? null;
}

/**
 * Every tag name this handle CLAIMS on parse: its primary spelling unless that
 * is `serializeOnly`, and every data-selected spelling. Empty when it claims
 * none.
 *
 * Exported for the `page.editor:markdown-tag-names-unique` check, so the check
 * and the runtime read ONE resolution: two handles claiming a name is otherwise
 * only discovered when a user pastes (`tagParsersOf` throws), and the `page`
 * type — registered by two different handles, and spelled two ways — makes that
 * a live hazard. Also read by the markdown-apply planner, to find which type
 * owns the `<page>` pointer on parse.
 */
export function markdownParseTagNames(h: BlockHandle<unknown>): string[] {
  const tags = tagsFor(h);
  if (!tags) return [];
  return [tags.primary, ...tags.spellings]
    .filter((t) => !t.serializeOnly)
    .map((t) => t.name);
}

/**
 * The tag name a row of this handle with this `data` is written under, or
 * `null` when its type maps to markdown LINES only.
 *
 * A type is not always its tag (`human-notes` stores `context` and tags
 * `<human>`), and since {@link BlockTag.spellings} one type is not even always
 * ONE tag (`page` is `<page>` or `<agent-page>`) — so a message an agent reads
 * has to name the spelling that is in the document in front of it, which only
 * the row's data can answer. The same selection the serializer runs, shared for
 * the reason {@link markdownParseTagNames} is.
 */
export function markdownTagNameOf(
  h: BlockHandle<unknown>,
  data: unknown,
): string | null {
  return tagForData(h, data)?.name ?? null;
}

/**
 * Which block TYPE would CLAIM this line away from plain prose, or `undefined`
 * when the line is ordinary prose. The line is taken as the parse walk sees it
 * — its own leading whitespace is stripped before anybody is offered it.
 *
 * The one question the escape mechanism asks, in both directions, exported so a
 * check and the round-trip suite ask it of the REAL registry rather than of a
 * re-implementation. It is {@link stealerOf} with the winner reduced to its type
 * — deliberately NOT {@link claimantOf}, whose answer for an unclaimed line is
 * the default-text handle, so "is this line claimed" asked as "is the answer
 * defined" comes out true of every line ever written. That is the trap; this
 * function exists so nobody has to avoid it twice.
 *
 * Builds the dispatch per call, so a caller asking about many lines pays for one
 * `claimersOf` each. That is the honest cost of taking a `MarkdownContext`
 * rather than a pre-built dispatch nobody outside this module can hold, and the
 * two callers are a build-time check and a test — neither is a hot path.
 */
export function markdownLineClaim(
  line: string,
  ctx: MarkdownContext,
): string | undefined {
  return stealerOf(line, claimersOf(ctx.handles))?.type;
}

/**
 * Whether ANY spelling of this handle's markdown tag carries its row id — see
 * {@link BlockTag.identified}.
 *
 * Exported so a consumer can derive the identified TYPE SET from the handle
 * registry it already holds. The one consumer is the markdown-apply planner,
 * which honours a node's `ref` as a pin only for a type that really round-trips
 * an id; naming the type there instead would be the collection-consumer leak
 * this codebase bans, and would silently stop pinning the day the type is
 * renamed. Any spelling counts, because a `ref` only ever comes off an
 * identified spelling's parse: `page` is in the set through `<agent-page
 * id="…"/>` while its primary `<page>` is not identified at all. Same resolution
 * the serializer and parser run, for the same reason `markdownParseTagNames` is
 * shared with the uniqueness check.
 */
export function markdownTagIsIdentified(h: BlockHandle<unknown>): boolean {
  const tags = tagsFor(h);
  if (!tags) return false;
  return [tags.primary, ...tags.spellings].some((t) => t.identified);
}

/**
 * Every tag name under which a block of these handles is DECLARED as written by
 * `author` — for a message that has to tell an agent where it may write,
 * without spelling a tag name literally.
 *
 * A handle's static `author` covers all of its spellings; a per-row
 * `authorFromData` is asked about each spelling's PRESET (the primary's being
 * the empty payload), which is the partial payload `BlockHandle.authorFromData`
 * documents it must answer from. An UNDECLARED author never matches — this lists
 * who a tag says it belongs to, and every paragraph saying nothing is not a tag
 * written by anybody in particular.
 */
export function markdownTagNamesAuthoredBy(
  handles: readonly BlockHandle<unknown>[],
  author: "agent" | "human",
): string[] {
  const names: string[] = [];
  for (const h of handles) {
    const tags = tagsFor(h);
    if (!tags) continue;
    for (const tag of [tags.primary, ...tags.spellings]) {
      const who = h.author ?? h.authorFromData?.(tag.preset ?? {});
      if (who === author && !names.includes(tag.name)) names.push(tag.name);
    }
  }
  return names;
}

/** How one block row turns into markdown: flat line(s), or a tag region. */
type ResolvedSerializer =
  | { kind: "lines"; serialize(data: unknown, ctx: MdSerializeCtx): string }
  | { kind: "tag"; tag: ResolvedTag };

function serializerFor(h: Handle, data: unknown): ResolvedSerializer {
  const explicit = h.markdown?.serialize;
  if (explicit) return { kind: "lines", serialize: explicit };
  const tag = tagForData(h, data);
  if (tag) return { kind: "tag", tag };
  // `tagForData` returns null here only for a text-bearing handle (a type with
  // neither takes the derived-tag branch above), so the lens is present.
  const lens = h.text!;
  const prefix = outputPrefix(h);
  return {
    kind: "lines",
    serialize: (d, ctx) => prefix + ctx.md(lens(d)),
  };
}

function parserFor(
  h: Handle,
): (line: string, ctx: MdParseCtx) => unknown | null {
  if (h.markdown?.parseLine) return h.markdown.parseLine.parse;
  const lens = h.text;
  if (lens) {
    const prefixes = derivedParsePrefixes(h);
    if (prefixes.length === 0) return () => null;
    const empty = h.empty;
    return (line, ctx) => {
      const prefix = prefixes.find((p) => line.startsWith(p));
      if (prefix === undefined) return null;
      return {
        ...(empty?.() ?? {}),
        text: ctx.runs(line.slice(prefix.length)),
      };
    };
  }
  return () => null;
}

// ---------------------------------------------------------------------------
// The claim authority: which handle would take a given line
// ---------------------------------------------------------------------------
//
// ONE ordering, read by BOTH directions. The parse walk consumes it to dispatch
// a line; the serialize walk asks it what the line it is about to write would
// come back as. Before it existed the serializer did not know what the parser
// would do with its own output, so a paragraph reading `3. Investigate…` went
// out as a bare line and came back a `numbered-list` — losing its row id, and
// with it the page's editability (`research/2026-09-20-page-markdown-line-claim-escape.md`).

/** A handle declaring a fenced multi-line form, bound to that declaration. */
interface FenceClaimer {
  handle: Handle;
  fence: NonNullable<BlockMarkdown<unknown>["fence"]>;
}

/** A handle declaring a line-run form, bound to that declaration. */
interface RunClaimer {
  handle: Handle;
  lineRun: NonNullable<BlockMarkdown<unknown>["lineRun"]>;
}

/** A non-`defaultText` handle with its resolved single-line parser. */
interface LineClaimer {
  handle: Handle;
  precedence: number;
  parse(line: string, ctx: MdParseCtx): unknown | null;
}

/**
 * The parse-side dispatch for one handle set, in the order a line is offered to
 * it: the fence arm first (a fence's opening line is its own claim and its body
 * is opaque), then the line-run arm (its first line is its claim — see
 * `BlockMarkdown.lineRun`), then the non-`defaultText` claimers by `precedence`
 * desc — a stable sort, so ties keep registration order — and last the
 * default-text handle, which never claims and always accepts.
 */
interface Claimers {
  fences: FenceClaimer[];
  runs: RunClaimer[];
  lines: LineClaimer[];
  /** THE plain-paragraph type; `undefined` in a composition shipping none. */
  fallback: Handle | undefined;
}

function claimersOf(handles: Handle[]): Claimers {
  return {
    fences: handles
      .filter((h) => h.markdown?.fence)
      .map((h) => ({ handle: h, fence: h.markdown!.fence! })),
    runs: handles
      .filter((h) => h.markdown?.lineRun)
      .map((h) => ({ handle: h, lineRun: h.markdown!.lineRun! })),
    lines: handles
      .filter((h) => !h.defaultText)
      .map((h) => ({
        handle: h,
        precedence: h.markdown?.precedence ?? 0,
        parse: parserFor(h),
      }))
      .sort((a, b) => b.precedence - a.precedence),
    fallback: defaultTextHandle(handles),
  };
}

/**
 * The stub parse context the TYPE probe runs against. Every `parseLine` today
 * uses `ctx.runs` only to fill the text it just matched — a field its own
 * predicate never inspects — so a probe handing back no runs decides exactly
 * what the real call would, and costs regex work rather than a second
 * `parseInlineMarkdown`. `parseMarkdownToForest` then re-invokes the winner with
 * the REAL context and REFUSES LOUDLY if the two disagree, so the assumption is
 * checked on every line rather than trusted.
 */
const PROBE_PARSE_CTX: MdParseCtx = { runs: () => [], protectedSpans: [] };

/** Which entry of a {@link Claimers} takes one line. */
type Claim =
  | { kind: "fence"; handle: Handle; fence: FenceClaimer["fence"] }
  | { kind: "run"; handle: Handle; lineRun: RunClaimer["lineRun"] }
  | { kind: "line"; handle: Handle; claimer: LineClaimer }
  | { kind: "prose"; handle: Handle };

/**
 * A line's content as the parse walk sees it: its own leading whitespace gone,
 * exactly as `parseMarkdownToForest` takes it off before offering a line to
 * anybody. Stated HERE, inside the authority, so no caller can probe a claim
 * against a string the parser would never show a claimer — a paragraph reading
 * `"  3. x"` is claimed by `numbered-list`, and a probe of the raw line says
 * prose, which is a block silently lost on the way back. Its two spaces are
 * CONTENT, so only the probe sees the stripped form: what reaches `ctx.runs`
 * keeps them.
 */
function lineContent(line: string): string {
  return line.replace(/^\s+/, "");
}

function claimOf(line: string, claimers: Claimers): Claim | undefined {
  const content = lineContent(line);
  const fence = claimers.fences.find((f) => content.startsWith(f.fence.open));
  if (fence) return { kind: "fence", handle: fence.handle, fence: fence.fence };
  // A line run is still a SINGLE-LINE claim here: its first line `matches`.
  // Whether the run then parses is the walk's business (a decline falls to
  // prose), exactly as a fence's opening line claims before its body is read.
  const run = claimers.runs.find((r) => r.lineRun.matches(content));
  if (run) return { kind: "run", handle: run.handle, lineRun: run.lineRun };
  for (const claimer of claimers.lines) {
    if (claimer.parse(content, PROBE_PARSE_CTX) !== null)
      return { kind: "line", handle: claimer.handle, claimer };
  }
  const { fallback } = claimers;
  return fallback === undefined
    ? undefined
    : { kind: "prose", handle: fallback };
}

/**
 * Which block type this DEDENTED line would parse back as — TYPE only, no
 * payload built. `undefined` only when the composition ships no default-text
 * type, which is the same answer {@link defaultTextHandle} gives every other
 * caller rather than an absorbed failure: the line then belongs to nobody.
 *
 * It deliberately does NOT model the tag branch. `claimTag` is multi-line and
 * can decline after consuming nothing, so it is not a single-line predicate —
 * and it does not need to be: a `lines`-branch line can only open with `<` if a
 * handle emits one, which {@link claimSafeLines} ASSERTS rather than assumes.
 */
function claimantOf(line: string, claimers: Claimers): Handle | undefined {
  return claimOf(line, claimers)?.handle;
}

/**
 * The block type that would STEAL this line from the plain-paragraph type, or
 * `undefined` when the line is ordinary prose.
 *
 * The distinction {@link claimantOf} cannot make on its own: its answer for an
 * unclaimed line is the default-text handle, so "is it claimed" asked as "is it
 * defined" is true of every line ever written. This is the question the escape
 * asks in both directions.
 */
function stealerOf(line: string, claimers: Claimers): Handle | undefined {
  const claim = claimOf(line, claimers);
  return claim && claim.kind !== "prose" ? claim.handle : undefined;
}

/**
 * The document line(s) ONE `lines`-branch node contributes, with the FIRST line
 * ESCAPED when another block type would claim it back.
 *
 * The backslash goes at index 0 of the WHOLE line, ahead of any leading
 * whitespace the text itself carries — so a paragraph reading `"  ---"` emits
 * `\  ---` and keeps its two spaces. Every claimer either anchors at `^` or
 * compares `trim()`, so index 0 defeats all of them; there is no position to
 * search for, and a FIXED position is what makes the decode exact.
 *
 * **Only the default-text type may be escaped.** A non-default owner whose own
 * line another type claims is a DEFECT and throws: escaping it would silently
 * convert the block to a paragraph on the way back (`\- [ ] x` no longer claims
 * `to-do`), which is precisely the damage this mechanism exists to close.
 * Unreachable today — every claiming type parses the line it emits, which the
 * check above now asserts on every block rather than assuming.
 *
 * `assertExact` is `softBreaks === "escaped"`, our own dialect, and it gates
 * EVERY throw here — one rule, so nobody has to reason per assert about which
 * ones a Cmd+C can reach: **our own dialect asserts; the clipboard never
 * throws.** That dialect is deliberately lossy and emits what it has.
 *
 * The ESCAPE itself is dialect-free and needs no fourth `MarkdownContext` field:
 * `\3. Investigate` is correct CommonMark and renders as the paragraph it is
 * wherever a person pastes it, so the clipboard is better with it, not worse.
 */
function claimSafeLines(
  line: string,
  handle: Handle | undefined,
  claimers: Claimers,
  assertExact: boolean,
): string[] {
  const lines = line.split("\n");
  // A type no handle in this composition declares emits "" and owns nothing —
  // `serializerFor` never ran for it — so there is no owner to check a claim
  // against. The walk passes it through exactly as it always has.
  if (handle === undefined) return lines;
  const first = lines[0]!;

  if (assertExact) {
    // ONE LINE, unless the type declares a multi-line form: a `fence` is
    // self-delimiting, so its lines 2..n are read back as part of the same
    // block, and a `lineRun` reads back every line that `matches` at its
    // indent. Any OTHER multi-line output fans one block out into siblings at
    // its own indent, indistinguishable from blocks nobody wrote — the soft
    // break's bug, still live for `equation`, which serializes `"$$" +
    // expression` straight out of a textarea. The comment at the call site
    // claimed this property already held; this is what makes it true.
    const lineRun = handle.markdown?.lineRun;
    if (
      lines.length > 1 &&
      handle.markdown?.fence === undefined &&
      lineRun === undefined
    ) {
      throw new Error(
        `markdown: a "${handle.type}" block emitted ${lines.length} lines, but only a type ` +
          "declaring a `markdown.fence` or a `markdown.lineRun` may — every other type's lines " +
          "2..n come back as sibling blocks nobody wrote. A soft break inside run text is " +
          "already spelled `\\n`; anything else multi-line needs a fence, a line run or a tag.",
      );
    }
    // A line run is read back only as far as its lines `matches`: one that
    // does not ends the run there, and every line after it comes back as a
    // sibling block nobody wrote.
    if (lineRun !== undefined) {
      const stray = lines.find((l) => !lineRun.matches(l));
      if (stray !== undefined) {
        throw new Error(
          `markdown: a "${handle.type}" block emitted the line ${JSON.stringify(stray)}, which its ` +
            "own `markdown.lineRun.matches` rejects — the run would end there on the way back " +
            "and the rest would parse as other blocks. Every line a line-run type writes must " +
            "match its own run.",
        );
      }
    }
    // NEVER OPENS WITH `<`. The claim authority skips the tag branch on purpose
    // (`claimTag` is multi-line and can decline after consuming nothing, so it
    // is not a single-line predicate) — this assert is what makes that omission
    // honest rather than assumed. `<` is an inline escape, so run text can never
    // produce one here; only a hand-written `markdown.serialize` could.
    if (lineContent(first).startsWith("<")) {
      throw new Error(
        `markdown: a "${handle.type}" block emitted the line ${JSON.stringify(first)}, which ` +
          "opens with `<`. A line that could open a TAG is outside what the claim authority can " +
          "answer (see `claimantOf`), so a type that wants a tag declares `markdown.tag` rather " +
          "than writing one by hand.",
      );
    }
  }

  // A WHITESPACE-ONLY line is claimed by nobody — the parser reads it as a
  // blank line, an EMPTY paragraph — so a paragraph whose text is only spaces
  // would come back with its text gone. It takes the same one backslash.
  const blank =
    handle === claimers.fallback && first !== "" && first.trim() === "";
  const claimant = claimantOf(first, claimers);
  if (claimant === handle && !blank) return lines;
  if (handle !== claimers.fallback) {
    // Unreachable in the clipboard dialect today — but the gate is the same one
    // sentence everywhere in this function, so nobody has to re-derive per
    // assert whether THIS one can fire during a Cmd+C. The clipboard emits the
    // line as it stands and keeps the loss, which is what that dialect is for.
    if (assertExact) {
      throw new Error(
        `markdown: a "${handle.type}" block emitted the line ${JSON.stringify(first)}, which ` +
          `parses back as "${claimant?.type ?? "nothing"}" — its \`markdown.serialize\` and its ` +
          "`markdown.parseLine` disagree. Escaping the line is NOT the answer here: it would " +
          "make the block a paragraph on the way back, which is the loss this check exists to " +
          "prevent. Only the default-text type may be escaped.",
      );
    }
    return lines;
  }
  const escaped = "\\" + first;
  const after = claimantOf(escaped, claimers);
  if (assertExact && after !== handle) {
    throw new Error(
      `markdown: a paragraph reading ${JSON.stringify(first)} is claimed by ` +
        `"${claimant?.type ?? "nothing"}", and escaping it as ${JSON.stringify(escaped)} still ` +
        `parses back as "${after?.type ?? "nothing"}". A line claim has to be defeated by one ` +
        "leading backslash — a claimer that matches one is a claimer no paragraph can escape.",
    );
  }
  return [escaped, ...lines.slice(1)];
}

// ---------------------------------------------------------------------------
// Tag lexing (one line of an open tag)
// ---------------------------------------------------------------------------
//
// Attribute values are DOUBLE-quoted, with `\` `"` and the two line terminators
// backslash-escaped — so a value can never end the quote or the line, which is
// what keeps an open tag exactly one line and therefore claimable line-wise.

function quoteAttr(value: string): string {
  let out = '"';
  for (const c of value) {
    if (c === "\\" || c === '"') out += "\\" + c;
    else if (c === "\n") out += "\\n";
    else if (c === "\r") out += "\\r";
    else out += c;
  }
  return out + '"';
}

/** `<name a="1" b="2"` — the open tag's prefix, without its `>` / `/>`. */
function openTagPrefix(name: string, attrs: Record<string, string>): string {
  let out = `<${name}`;
  for (const [key, value] of Object.entries(attrs))
    out += ` ${key}=${quoteAttr(value)}`;
  return out;
}

const TAG_NAME_AT_START = /^<([A-Za-z][A-Za-z0-9_-]*)/;
const ATTR_AT = /^([A-Za-z_][A-Za-z0-9_-]*)="((?:[^"\\]|\\.)*)"/;

interface OpenTag {
  name: string;
  attrs: Record<string, string>;
  selfClosing: boolean;
  /** Index in `line` just past the `>` / `/>`. */
  end: number;
}

/** Undo {@link quoteAttr}. An unknown escape yields the character alone. */
function unquoteAttr(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== "\\" || i + 1 >= raw.length) {
      out += raw[i]!;
      continue;
    }
    const next = raw[i + 1]!;
    out += next === "n" ? "\n" : next === "r" ? "\r" : next;
    i += 1;
  }
  return out;
}

/**
 * The open tag `line` starts with, or `null` when it does not start with a
 * well-formed one. `null` is not an absorbed failure: "this line is not a tag"
 * is the dominant answer (every prose line reaches here), and the caller's
 * response is to keep parsing the line as prose — the lenient half of the
 * contract.
 */
function matchOpenTag(line: string): OpenTag | null {
  const nameMatch = TAG_NAME_AT_START.exec(line);
  if (!nameMatch) return null;
  const attrs: Record<string, string> = {};
  let i = 1 + nameMatch[1]!.length;
  for (;;) {
    if (line.startsWith("/>", i)) {
      return { name: nameMatch[1]!, attrs, selfClosing: true, end: i + 2 };
    }
    if (line[i] === ">") {
      return { name: nameMatch[1]!, attrs, selfClosing: false, end: i + 1 };
    }
    // Attributes must be whitespace-separated; anything else is not a tag.
    if (line[i] !== " ") return null;
    while (line[i] === " ") i += 1;
    if (line.startsWith("/>", i) || line[i] === ">") continue;
    const attr = ATTR_AT.exec(line.slice(i));
    if (!attr) return null;
    attrs[attr[1]!] = unquoteAttr(attr[2]!);
    i += attr[0].length;
  }
}

/**
 * One tag line, in THIS document's tag spelling — `<name a="1">`, or
 * `<name a="1"/>` when `selfClosing`. Exported for a reader-side header that is
 * written beside a page's document without being a block of it (the
 * `<page-meta>` header `markdown-apply` prepends): its tags must quote their
 * attributes exactly as the blocks' tags do, or the one document would speak
 * two attribute dialects.
 */
export function formatTagLine(
  name: string,
  attrs: Record<string, string>,
  selfClosing: boolean,
): string {
  return openTagPrefix(name, attrs) + (selfClosing ? "/>" : ">");
}

/** What {@link parseTagLine} reads off one line. */
export interface TagLine {
  name: string;
  attrs: Record<string, string>;
  selfClosing: boolean;
}

/**
 * The inverse of {@link formatTagLine}: the open tag `line` consists of, and
 * nothing else after it. A discriminated result — "this line is not a tag" is
 * the answer a header reader has to refuse with, so it is not a `null` it could
 * read past.
 */
export function parseTagLine(
  line: string,
): { ok: true; tag: TagLine } | { ok: false } {
  const open = matchOpenTag(line);
  if (open === null || open.end !== line.length) return { ok: false };
  return {
    ok: true,
    tag: { name: open.name, attrs: open.attrs, selfClosing: open.selfClosing },
  };
}

// ---------------------------------------------------------------------------
// Parse: markdown text → forest
// ---------------------------------------------------------------------------

/**
 * `children` is present only for a tag token: a tag's body is parsed
 * RECURSIVELY, so those children come from the body rather than from the
 * indentation stack `tokensToTree` walks.
 *
 * `ref` likewise only ever comes from a tag — the reserved `id` attribute of an
 * {@link BlockTag.identified} one, lifted off before any data parsing.
 */
type FlatToken = {
  indent: number;
  type: string;
  data: unknown;
  children?: SerializedBlock[];
  ref?: string;
};

/**
 * The tag name → owning spelling map, built per call. Exactly the set of tags
 * the SERIALIZER can emit — every spelling of every handle — minus the
 * `serializeOnly` primaries, so a name that comes out can always go back in.
 * Iterating the spellings keeps "exactly one handle claims a name" the one rule
 * it was: a second spelling is a second NAME, never a second claim on one.
 */
function tagParsersOf(handles: Handle[]): Map<string, ResolvedTag> {
  const byName = new Map<string, ResolvedTag>();
  for (const h of handles) {
    const tags = tagsFor(h);
    if (!tags) continue;
    for (const tag of [tags.primary, ...tags.spellings]) {
      if (tag.serializeOnly) continue;
      const existing = byName.get(tag.name);
      if (existing) {
        throw new Error(
          `markdown: block types "${existing.handle.type}" and "${h.type}" both claim the ` +
            `<${tag.name}> tag on PARSE. Exactly one may own a name; the other must declare ` +
            "`markdown.tag.serializeOnly` (as `page`'s primary spelling does, so `<page/>` " +
            "parses as a page-link).",
        );
      }
      byName.set(tag.name, tag);
    }
  }
  return byName;
}

/**
 * Strip UP TO `indent` columns of leading whitespace — never blindly, so genuine
 * leading whitespace inside a fenced body survives. A tab counts as the 2
 * columns the indent measurement above gives it.
 */
function dedent(line: string, indent: number): string {
  let i = 0;
  let consumed = 0;
  while (i < line.length && consumed < indent) {
    const c = line[i]!;
    if (c === " ") consumed += 1;
    else if (c === "\t") consumed += 2;
    else break;
    i += 1;
  }
  return line.slice(i);
}

export function parseMarkdownToForest(
  text: string,
  ctx: MarkdownContext,
): SerializedBlock[] {
  const { handles } = ctx;
  const parseCtx = parseCtxFor(ctx);
  // The ONE dispatch order, shared with the serialize side — see `claimersOf`.
  const claimers = claimersOf(handles);
  const fallback = claimers.fallback;
  const fences = claimers.fences.map((f) => f.fence);
  const tagParsers = tagParsersOf(handles);

  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const tokens: FlatToken[] = [];

  // A blank line carries no indentation of its own, so the block it stands for
  // is placed by the block that FOLLOWS it: the run is held here and flushed at
  // the next token's own indent, which `tokensToTree` then reads as "previous
  // sibling of that token". Two drops fall out of that one counter rather than
  // being rules of their own, and both are the dialect's accepted loss (see
  // `research/2026-09-01-page-blank-line-empty-paragraph.md`): a run with no
  // token BEFORE it in this scope flushes nothing, and a run with no token after
  // it is never flushed at all. A tag body recurses through this same function,
  // so "this scope" means the document or one container's body.
  let pendingBlanks = 0;
  const flushBlanks = (indent: number): void => {
    // `tokens.length === 0` is the leading-run drop. A composition shipping no
    // default-text type has nothing to mint, and skips blank lines as it always
    // did — the same answer `defaultTextHandle` gives every other caller.
    if (tokens.length > 0 && fallback) {
      for (let n = 0; n < pendingBlanks; n++) {
        tokens.push({
          indent,
          type: fallback.type,
          data: { ...(fallback.empty?.() ?? {}), text: [] },
        });
      }
    }
    pendingBlanks = 0;
  };

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i]!;
    if (raw.trim() === "") {
      // Under `"separator"` nothing is ever counted, so nothing can ever be
      // flushed: this dialect is byte-identical to the skip it replaced.
      if (ctx.blankLines === "empty-block") pendingBlanks++;
      i++;
      continue;
    }
    const ws = /^(\s*)/.exec(raw)![1]!;
    const indent = ws.replace(/\t/g, "  ").length;
    const content = raw.slice(ws.length);

    // Tag-delimited region — the ONLY pass that can produce children, since a
    // `parseLine` sees one line and a `fence` body is an opaque string. A line
    // opening `<name` for a REGISTERED name claims through its matching
    // `</name>` (depth-counted, so containers nest), and the dedented body
    // recurses through this same function.
    //
    // Nothing here (or anywhere else in this module) reads `typingPrefixes`:
    // that field is input syntax, not markdown syntax, so a `TODO ` line in
    // pasted prose stays prose and a `| ` line stays a table row rather than
    // becoming a quote. This pass keys on the tag NAME alone.
    if (content.startsWith("<")) {
      const claimed = claimTag(
        lines,
        i,
        indent,
        content,
        tagParsers,
        fences,
        parseCtx,
        ctx,
      );
      if (claimed) {
        flushBlanks(indent);
        tokens.push(claimed.token);
        i = claimed.next;
        continue;
      }
    }

    // WHICH HANDLE TAKES THIS LINE — asked once, of the authority the
    // serializer checks its own output against, so the two cannot drift. The
    // tag pass above is deliberately outside it (see `claimantOf`).
    const claim = claimOf(content, claimers);

    // Fenced multi-line (code): capture the info string, accumulate until the
    // closing fence, then hand the body to the type's `parseFenced`.
    if (claim?.kind === "fence") {
      const { fence } = claim;
      const info = content.slice(fence.open.length).trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(fence.close)) {
        // The serializer indents EVERY line of a multi-line block by its depth,
        // so a nested fence's body arrives carrying the fence token's own
        // indent. Pushing it raw made a nested code block accrete two spaces per
        // round trip.
        body.push(dedent(lines[i]!, indent));
        i++;
      }
      if (i < lines.length) i++; // consume closing fence
      flushBlanks(indent);
      tokens.push({
        indent,
        type: claim.handle.type,
        data: fence.parseFenced(info, body.join("\n"), parseCtx),
      });
      continue;
    }

    // Line run (a table): the lines that follow at the SAME indent, non-blank,
    // each matching on its own. The indent compare is explicit — a deeper line
    // is a child of whatever this run parses to, never a continuation of it.
    // The type takes the longest prefix it accepts; whatever it leaves is
    // offered to the loop again, so one run can hold several blocks.
    if (claim?.kind === "run") {
      const { lineRun } = claim;
      const run: string[] = [content];
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j]!;
        if (next.trim() === "") break;
        const nextWs = /^(\s*)/.exec(next)![1]!;
        if (nextWs.replace(/\t/g, "  ").length !== indent) break;
        const nextContent = next.slice(nextWs.length);
        if (!lineRun.matches(nextContent)) break;
        run.push(nextContent);
      }
      const parsed = lineRun.parse(run, parseCtx);
      flushBlanks(indent);
      if (parsed === null) {
        // DECLINED: the first line is prose, verbatim — never the escaped
        // branch below, since nothing was escaped. The serializer writes it
        // back escaped (lenient parse, canonical serialize).
        if (fallback !== undefined) {
          tokens.push({
            indent,
            type: fallback.type,
            data: {
              ...(fallback.empty?.() ?? {}),
              text: parseCtx.runs(content),
            },
          });
        }
        i++;
        continue;
      }
      if (
        !Number.isInteger(parsed.consumed) ||
        parsed.consumed < 1 ||
        parsed.consumed > run.length
      ) {
        throw new Error(
          `markdown: "${claim.handle.type}"'s \`markdown.lineRun.parse\` reported consuming ` +
            `${parsed.consumed} of the ${run.length} line(s) it was handed. It takes a PREFIX of ` +
            "the run — at least its first line, never more than it was given — or declines with `null`.",
        );
      }
      tokens.push({ indent, type: claim.handle.type, data: parsed.data });
      i += parsed.consumed;
      continue;
    }

    // A LINE-LEADING BACKSLASH MAKES THE LINE PROSE. It is how the serializer
    // spells a paragraph whose own text opens with another type's line marker
    // (`3. Investigate…`, `- x`, `---`): one `\` at index 0, which every claimer
    // fails to match because each of them anchors at `^` or compares `trim()`.
    // Strip that ONE backslash and hand the remainder to the default-text handle
    // directly — never back to the claimers, which by definition would take it.
    //
    // Conditional on a real CLAIM, never on the backslash alone: a block whose
    // text is a lone soft break emits the line `\n` (backslash + the letter
    // `n`), and an unconditional strip would rewrite that block's text to `n`.
    //
    // The remainder keeps its own leading whitespace — `stealerOf` strips the
    // indent to ASK the question, exactly as the walk above did, while those
    // spaces are the paragraph's content.
    //
    // BLOCK LEVEL, before the inline parse, and it must be: `isEscapeAt`
    // (`inline-markdown.ts`) treats a backslash as an escape only before one of
    // that table's nine spellings, and `3`, `-`, `+`, `#`, `>`, `$` are not
    // among them — so the inline layer is blind to this escape by construction,
    // there is no double decode, and what reaches `ctx.runs` is byte-identical
    // to what the serializer held before inserting. Unconditional across
    // dialects, like every other decode here (lenient on parse, canonical on
    // serialize), and this one costs no leniency at all: `\- x` in foreign
    // pasted markdown means a literal `- x` paragraph in CommonMark too.
    if (fallback !== undefined && content.startsWith("\\")) {
      const bare = content.slice(1);
      // …or whose text is only whitespace, which no claimer takes but the
      // blank-line rule above would (see `claimSafeLines`).
      const blankText = bare !== "" && bare.trim() === "";
      if (blankText || stealerOf(bare, claimers) !== undefined) {
        flushBlanks(indent);
        tokens.push({
          indent,
          type: fallback.type,
          data: { ...(fallback.empty?.() ?? {}), text: parseCtx.runs(bare) },
        });
        i++;
        continue;
      }
    }

    // Non-default claiming handles, precedence desc, first non-null wins — the
    // winner named by `claimOf` above, re-invoked here with the REAL context.
    if (claim?.kind === "line") {
      const data = claim.claimer.parse(content, parseCtx);
      if (data === null) {
        throw new Error(
          `markdown: "${claim.handle.type}" claimed the line ${JSON.stringify(content)} when ` +
            "probed and DECLINED it with the real parse context. A `parseLine` decides its match " +
            "from the line alone — `ctx.runs` fills the text it matched, it never decides the " +
            "match — or the claim authority the serializer checks its own output against is " +
            "answering a different question from the one the parser asks.",
        );
      }
      flushBlanks(indent);
      tokens.push({ indent, type: claim.handle.type, data });
      i++;
      continue;
    }

    // Plain paragraph → default text type.
    if (claim) {
      flushBlanks(indent);
      tokens.push({
        indent,
        type: claim.handle.type,
        data: {
          ...(claim.handle.empty?.() ?? {}),
          text: parseCtx.runs(content),
        },
      });
    }
    i++;
  }

  return tokensToTree(tokens);
}

/** Strip the COMMON leading indentation of a tag body, preserving its shape. */
function dedentBlock(lines: string[]): string[] {
  let min = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    if (line.trim() === "") continue;
    min = Math.min(min, /^(\s*)/.exec(line)![1]!.replace(/\t/g, "  ").length);
  }
  if (!Number.isFinite(min) || min === 0) return lines;
  return lines.map((line) => dedent(line, min));
}

/**
 * One token for a tag whose body was claimed. `bodyLines` arrive ALREADY
 * dedented — the caller knows which form it read, and the single-line form's
 * inner text is verbatim (dedenting it would eat a leading space the text
 * genuinely carries).
 */
function tagToken(
  tag: ResolvedTag,
  indent: number,
  attrs: Record<string, string>,
  bodyLines: string[],
  parseCtx: MdParseCtx,
  ctx: MarkdownContext,
): FlatToken {
  if (tag.body === "none") {
    // LOUD, never a silent drop: `<page id="x">…</page>` names a page whose
    // content lives in its own `page_id` partition, and a body here would read
    // as content authored THROUGH the pointer. The one tag that may carry a
    // page's body is `<agent-page>`'s MINT form, where the page is new and the
    // body is its first content; an existing page's content is written by its
    // own id. Swallowing the body would hide that distinction.
    throw new Error(
      `markdown: <${tag.name}> takes no body, but one was written. This tag is a POINTER ` +
        "— its content lives elsewhere and cannot be authored through it.",
    );
  }
  if (tag.body === "text") {
    return {
      indent,
      type: tag.handle.type,
      data: tag.dataOf(attrs, bodyLines.join("\n"), parseCtx),
      children: [],
    };
  }
  return {
    indent,
    type: tag.handle.type,
    data: tag.dataOf(attrs, null, parseCtx),
    children: parseMarkdownToForest(bodyLines.join("\n"), ctx),
  };
}

/**
 * Claim the tag region starting at `lines[start]`, or `null` when this line does
 * not open a registered tag (it is then ordinary prose — the lenient half of the
 * contract; foreign `<div>`s and a line that merely begins with `<` still paste
 * as text).
 */
function claimTag(
  lines: string[],
  start: number,
  indent: number,
  content: string,
  tagParsers: Map<string, ResolvedTag>,
  fences: { open: string; close: string }[],
  parseCtx: MdParseCtx,
  ctx: MarkdownContext,
): { token: FlatToken; next: number } | null {
  const open = matchOpenTag(content);
  if (!open) return null;
  const tag = tagParsers.get(open.name);
  if (!tag) return null;
  const rest = content.slice(open.end);
  const close = `</${open.name}>`;

  // The reserved `id` of an `identified` tag is the ROW this node addresses, not
  // a field of its payload — so it comes off the attribute record here, before
  // `dataOf` (and through it the handle's own `schema.parse`) ever sees it.
  // Leaving it in place is exactly the failure this is written against: a void
  // `z.object({})` STRIPS the unknown key, which would make the attribute
  // decorative — the document says which card it is editing and the applier
  // never hears it, so alignment is free to re-pair a card with another card's
  // row and detach its authorship.
  const ref = tag.identified ? takeRef(open.attrs) : undefined;
  if (tag.pointerOnly !== null && ref === undefined) {
    throw new Error(
      `markdown: <${open.name}> without an \`id\` would create a new one, and this tag can ` +
        `only point at an existing row. ${tag.pointerOnly}`,
    );
  }

  // The `annotated` attributes come off here for the SAME reason and in the same
  // place: they were supplied from outside `data` on the way out, so they are not
  // fields of the payload and must not reach `dataOf` (or, through it, the
  // handle's own `schema.parse`). Leaving one in place is the failure this is
  // written against from both ends — a void `z.object({})` STRIPS the unknown key
  // and the attribute is merely decorative, while a strict schema rejects the
  // document outright over an attribute this side emitted itself.
  //
  // The VALUES are DISCARDED, deliberately. These attributes are read-only: the
  // row they describe lives in another table, and a pure parser can neither tell
  // an edited value from the one it was handed nor write the owner. See
  // {@link BlockTag.annotated}.
  for (const name of tag.annotated) delete open.attrs[name];

  const withRef = (token: FlatToken): FlatToken =>
    ref === undefined ? token : { ...token, ref };

  if (open.selfClosing) {
    if (rest.trim() !== "") return null;
    return {
      token: withRef({
        indent,
        type: tag.handle.type,
        data: tag.dataOf(open.attrs, null, parseCtx),
        children: [],
      }),
      next: start + 1,
    };
  }

  // Single-line form: `<name …>body</name>` — how a `"text"` body is emitted.
  if (rest.endsWith(close)) {
    const inner = rest.slice(0, rest.length - close.length);
    return {
      token: withRef(tagToken(tag, indent, open.attrs, [inner], parseCtx, ctx)),
      next: start + 1,
    };
  }
  if (rest.trim() !== "") return null;

  // Multi-line form: scan to the MATCHING close, counting nested opens of the
  // same name so containers of one type nest correctly.
  const depthDelta = (line: string): number => {
    if (line.startsWith(close)) return -1;
    const nested = matchOpenTag(line);
    if (!nested || nested.name !== open.name) return 0;
    if (nested.selfClosing) return 0;
    return line.slice(nested.end).endsWith(close) ? 0 : 1;
  };
  const body: string[] = [];
  let depth = 1;
  let j = start + 1;
  // A FENCED region inside the body is opaque: its lines are code, so a
  // `</name>` sitting in a string literal must not close this tag.
  let fenceClose: string | null = null;
  for (; j < lines.length; j++) {
    const line = lines[j]!.trim();
    if (fenceClose !== null) {
      if (line.startsWith(fenceClose)) fenceClose = null;
    } else {
      const opened = fences.find((f) => line.startsWith(f.open));
      if (opened) fenceClose = opened.close;
      else {
        depth += depthDelta(line);
        if (depth === 0) break;
      }
    }
    body.push(lines[j]!);
  }
  // Unterminated: the document ended inside the tag. Decline the claim rather
  // than swallowing the rest of the document into a block it never closed.
  if (depth !== 0) return null;
  return {
    token: withRef(
      tagToken(tag, indent, open.attrs, dedentBlock(body), parseCtx, ctx),
    ),
    next: j + 1,
  };
}

/**
 * Take the reserved `id` attribute OFF `attrs` and hand it back as the node's
 * row ref. Mutating is safe and deliberate: `matchOpenTag` built this record for
 * this one claim, and removing the key is what keeps the attribute out of every
 * downstream `dataOf` path (derived projection and a declared `parseAttrs`
 * alike) rather than each of them having to remember to skip it.
 *
 * An absent or EMPTY value yields `undefined`, and the caller then sets no `ref`
 * field at all — never `ref: undefined`. A tagless `<agent-note>` is a
 * legitimate document ("mint me a card"), and it must be structurally identical
 * to the same card parsed off the clipboard, not merely equal modulo undefined.
 */
function takeRef(attrs: Record<string, string>): string | undefined {
  const raw = attrs.id;
  delete attrs.id;
  return raw === undefined || raw === "" ? undefined : raw;
}

function tokensToTree(tokens: FlatToken[]): SerializedBlock[] {
  const roots: SerializedBlock[] = [];
  const stack: { indent: number; node: SerializedBlock }[] = [];
  for (const tok of tokens) {
    const node: SerializedBlock = {
      type: tok.type,
      data: tok.data,
      // Every creation path in the editor mints `expanded: true` ("a block is
      // born expanded"), and a self-closing tag cannot distinguish "collapsed"
      // from "childless" anyway — so a parsed forest is uniformly expanded, as
      // it has always been.
      expanded: true,
      children: tok.children ?? [],
      // Spread, so a node with no ref carries no `ref` KEY — see `takeRef`.
      ...(tok.ref === undefined ? {} : { ref: tok.ref }),
    };
    while (stack.length && stack[stack.length - 1]!.indent >= tok.indent) {
      stack.pop();
    }
    if (stack.length) stack[stack.length - 1]!.node.children.push(node);
    else roots.push(node);
    stack.push({ indent: tok.indent, node });
  }
  return roots;
}

// ---------------------------------------------------------------------------
// Serialize: forest → markdown text
// ---------------------------------------------------------------------------

/**
 * Nest one rendered sibling list under its parent (two columns per level).
 *
 * An EMPTY line stays empty. It is an empty paragraph, and padding it would emit
 * trailing whitespace — stripped in transit, and noise in a diff. Nothing
 * downstream wants the padding either: a blank line's own indent is never read
 * (its block takes the indent of the block that follows it), and `dedentBlock`
 * already skips blank lines when measuring a tag body's common indent.
 */
function indentLines(lines: string[]): string[] {
  return lines.map((line) => (line === "" ? line : "  " + line));
}

/**
 * The open tag's attributes, with the RESERVED ones lifted in FRONT of the
 * type's own — the `id` of an {@link BlockTag.identified} tag first, then the
 * {@link BlockTag.annotated} values the caller supplied, in declaration order.
 * So the address is the first thing anything reading the line sees, the facts
 * about the row come next, and both stay in one place across types.
 *
 * **`id` is first whoever supplies it.** A `<page id="…"/>` pointer's id is the
 * type's OWN attribute (a sub-page's `attrs` reads `ctx.id`; a link-to-page
 * block's is the page it points at), not the reserved one — and it is still the
 * address, so it stays in front of the annotated `title` both kinds carry. The
 * two pointer kinds therefore read the same way round, `<page id="…" title="…"/>`,
 * as every identified tag does.
 *
 * **An absent value omits the attribute rather than throwing**, for `id` and for
 * every annotation alike. An id-less, annotation-less forest is the clipboard
 * (copy/paste, a fuzz round trip) and it must still serialize: the bare
 * `<agent-note>` it produces is portable markdown that mints a fresh card
 * wherever it is pasted. `page` is the type that throws instead, and the
 * difference is not an inconsistency — a sub-page's identity IS its row, so an
 * id-less pointer would point at nothing.
 *
 * Two LOUD failures rather than a silent overwrite or a silent drop:
 *
 * - a declared `attrs` emitting a reserved name itself. `resolveTag` catches the
 *   schema-shaped half of that collision at resolution time; this catches the
 *   half only a function body knows. For an annotated name it fires whether or
 *   not a value was supplied this time — the conflict is in the declaration, and
 *   a failure that waits for the first annotated document is one that ships.
 * - a node carrying an annotation the tag never declared. Emitting it would make
 *   it a `data` key on the way back in (nothing reserves it, so `claimTag` leaves
 *   it for the schema); dropping it would make a fact its supplier believes is in
 *   the document silently absent.
 */
function tagAttrs(
  tag: ResolvedTag,
  data: unknown,
  ctx: MdSerializeCtx,
): Record<string, string> {
  const attrs = tag.attrsOf(data, ctx);
  const reserved: Record<string, string> = {};

  if (tag.identified && ctx.id !== undefined) {
    if ("id" in attrs) {
      throw new Error(
        `markdown: <${tag.name}> declares \`identified\`, which reserves the \`id\` attribute for ` +
          "the block's ROW id, but its own `attrs` emitted an `id` too. One of the two must go.",
      );
    }
    reserved.id = ctx.id;
  }

  const supplied = ctx.annotations;
  for (const name of Object.keys(supplied ?? {})) {
    if (!tag.annotated.includes(name)) {
      throw new Error(
        `markdown: a "${tag.handle.type}" node was given the annotation \`${name}\`, which ` +
          `<${tag.name}> does not declare in \`markdown.tag.annotated\`. An undeclared attribute ` +
          "is not reserved on the way back in, so it would parse as a `data` key — declare the " +
          "name, or stop supplying it.",
      );
    }
  }
  for (const name of tag.annotated) {
    if (name in attrs) {
      throw new Error(
        `markdown: <${tag.name}> declares \`${name}\` in \`markdown.tag.annotated\`, which reserves ` +
          "that attribute for a value supplied from OUTSIDE the block's data, but its own `attrs` " +
          "emitted one too. One of the two must go.",
      );
    }
    const value = supplied?.[name];
    if (value !== undefined) reserved[name] = value;
  }

  if (Object.keys(reserved).length === 0) return attrs;
  const { id: ownId, ...own } = attrs;
  return ownId === undefined
    ? { ...reserved, ...own }
    : { id: ownId, ...reserved, ...own };
}

/**
 * A node's annotations have exactly one place to go — its open tag's attribute
 * list — so a node carrying one for a type that serializes as plain LINES (or
 * that no handle claims at all) is a defect, not a no-op. Same refusal
 * {@link tagAttrs} makes for an undeclared name, at the other branch of the same
 * decision: whoever supplied the value believes the document carries it.
 */
function assertNoLineAnnotations(node: MarkdownNode): void {
  const names = Object.keys(node.annotations ?? {});
  if (names.length === 0) return;
  throw new Error(
    `markdown: a "${node.type}" node was given the annotation(s) ${names.join(", ")}, but this ` +
      "type serializes as markdown LINES, which have no attributes to carry them. Only a " +
      "`markdown.tag` declaring them in `annotated` can.",
  );
}

/** One sibling list, rendered: its lines, and whether the last one is a tag's. */
interface RenderedList {
  lines: string[];
  endsWithTag: boolean;
}

const EMPTY_LIST: RenderedList = { lines: [], endsWithTag: false };

/**
 * One node of a sibling list, rendered: its own line(s) — in both spellings when
 * it is an empty block that could be pinned — and the children the walk emits
 * below them.
 */
interface Segment {
  head: string[];
  /** The `<text/>` spelling of an empty block, when its handle has a tag. */
  pinnedHead: string[] | null;
  /** Whether `head` is a tag region (its first and last lines are tag lines). */
  headIsTag: boolean;
  /** The children the WALK emits below the head (a consuming tag has none). */
  children: RenderedList;
  hasChildren: boolean;
}

function startsWithTag(seg: Segment, pinned: boolean): boolean {
  return pinned || seg.headIsTag;
}

function endsWithTag(seg: Segment, pinned: boolean): boolean {
  if (seg.children.lines.length > 0) return seg.children.endsWithTag;
  return pinned || seg.headIsTag;
}

/**
 * THE PIN: which empty blocks of one sibling list are spelled as their tag
 * (`<text/>`) rather than as a blank line.
 *
 * A blank line carries no indentation of its own: the parser places it by the
 * block that FOLLOWS it and drops a run with nothing before or after it. So an
 * empty block is pinned when it:
 *
 * - carries children (a blank line would land under them),
 * - is the first or the last of its sibling list (a leading / trailing run), or
 * - sits beside a line that is a tag's: the neighbour before it ENDS with a tag
 *   line, or the neighbour after it STARTS with one. The parser would read that
 *   blank line back fine; what it buys is a READ that never holds a blank line
 *   beside a tag, so that in text an agent writes such a line has one meaning —
 *   spacing — and {@link dropBlankLinesBesideTags} can drop it without ever
 *   dropping an empty paragraph the agent copied from a read.
 *
 * The third rule feeds itself — a pinned block IS a tag line — so a run of empty
 * blocks beside a card is pinned whole. It only ever adds pins, so iterating to
 * a fixed point terminates.
 */
function pinnedAt(segments: readonly Segment[]): boolean[] {
  const last = segments.length - 1;
  const pinned = segments.map(
    (seg, i) =>
      seg.pinnedHead !== null && (seg.hasChildren || i === 0 || i === last),
  );
  for (let changed = true; changed;) {
    changed = false;
    for (const [i, seg] of segments.entries()) {
      if (pinned[i] || seg.pinnedHead === null) continue;
      const prev = i > 0 && endsWithTag(segments[i - 1]!, pinned[i - 1]!);
      const next = i < last && startsWithTag(segments[i + 1]!, pinned[i + 1]!);
      if (prev || next) {
        pinned[i] = true;
        changed = true;
      }
    }
  }
  return pinned;
}

export function serializeForestToMarkdown(
  forest: MarkdownNode[],
  ctx: MarkdownContext,
): string {
  const byType = new Map(ctx.handles.map((h) => [h.type, h] as const));
  // What the PARSER would do with each line this walk writes — built once here
  // and closed over by `renderList`. Deliberately not memoised on `ctx.handles`:
  // `serverMarkdownContext()` mints a fresh array per call, so a WeakMap keyed
  // on it would only ever grow.
  const claimers = claimersOf(ctx.handles);
  const md = (text: RichText | string): string =>
    serializeInlineMarkdown(runsOf(text), ctx.protectedSpans, ctx.softBreaks);
  const mdLine = (text: RichText | string): string =>
    serializeInlineMarkdown(runsOf(text), ctx.protectedSpans, "escaped");

  // Returns the lines for ONE sibling list, at depth 0; the caller indents. The
  // recursion carries the nesting rather than a `depth` counter so a tag can
  // render its own children INSIDE itself and tell the walk not to re-emit them.
  //
  // Two passes, because whether an empty paragraph is PINNED depends on its
  // neighbours: the first renders every node into a segment (an empty one in
  // both spellings), the second decides the pins and joins the segments.
  const renderList = (nodes: MarkdownNode[]): RenderedList => {
    const segments: Segment[] = [];
    // Per-sibling-list ordinal: 1-based position within the consecutive run of
    // same-type siblings, reset on type change. Each recursive child list starts
    // its own fresh counter (matches render-time numbering).
    let ordinal = 0;
    let prevType: string | null = null;
    for (const n of nodes) {
      ordinal = n.type === prevType ? ordinal + 1 : 1;
      prevType = n.type;
      const h = byType.get(n.type);
      const serializeCtx: MdSerializeCtx = {
        md,
        mdLine,
        protectedSpans: ctx.protectedSpans,
        plain: plainOf,
        ordinal,
        id: n.id,
        annotations: n.annotations,
      };
      const resolved = h ? serializerFor(h, n.data) : null;

      // Flat line(s): the walk owns the children, exactly as it always has.
      if (resolved === null || resolved.kind === "lines") {
        assertNoLineAnnotations(n);
        const line =
          resolved === null ? "" : resolved.serialize(n.data, serializeCtx);
        const children = renderList(n.children);
        // The pin's spelling, for an EMPTY block only. Whether it is used is the
        // second pass's call (see `pinnedAt`). A handle with no tag keeps the
        // blank line — the pin never invents a spelling, so that loss stays,
        // honestly.
        //
        // It replaces only the LINE: the walk still emits `n.children` below,
        // exactly as for any other flat line. Routing through the tag branch
        // would be a silent delete — a `body: "none"` tag self-closes and
        // CONSUMES its children.
        const pinTag =
          ctx.emptyBlocks === "pinned" && line.trim() === ""
            ? h && tagForData(h, n.data)
            : null;
        segments.push({
          // THE LINE A BLOCK EMITS IS CLAIMED BY THAT BLOCK, OR IT IS ESCAPED —
          // `claimSafeLines` is the whole of it, and it also owns the split.
          //
          // The split STAYS, and `code-block` is its one reason: it declares an
          // explicit `markdown.serialize` returning a genuinely multi-line
          // fenced string, and a declared serializer takes this branch. Every
          // other type here emits ONE line — which used to be a statement about
          // the handles that happen to be registered and is now ASSERTED in our
          // own dialect, because `equation` was a live counter-example (a
          // multi-line LaTeX expression fanned out here exactly as a soft break
          // used to). Do NOT move the soft-break escape here either: at this
          // point the string is opaque (prefix, fence and inline text already
          // concatenated), so escaping would collapse every fenced block onto
          // one line and turn the code's own newlines into `\n`.
          head: claimSafeLines(line, h, claimers, ctx.softBreaks === "escaped"),
          pinnedHead: pinTag
            ? [
                `${openTagPrefix(pinTag.name, tagAttrs(pinTag, n.data, serializeCtx))}/>`,
              ]
            : null,
          headIsTag: false,
          children,
          hasChildren: n.children.length > 0,
        });
        continue;
      }

      const tag = resolved.tag;
      const prefix = openTagPrefix(
        tag.name,
        tagAttrs(tag, n.data, serializeCtx),
      );
      if (tag.body === "text") {
        // The block's OWN text between the tags; children still nest below, as
        // for any text block.
        const text = md(h!.text!(n.data));
        segments.push({
          head: text.includes("\n")
            ? [`${prefix}>`, ...indentLines(text.split("\n")), `</${tag.name}>`]
            : [`${prefix}>${text}</${tag.name}>`],
          pinnedHead: null,
          headIsTag: true,
          children: renderList(n.children),
          hasChildren: n.children.length > 0,
        });
        continue;
      }

      // A tag CONSUMES its children — emitting them inside, or (collapsed /
      // pointer) deliberately not at all. Either way the walk must not re-emit
      // them, which is why this is an explicit branch and never inferred.
      const emitsChildren =
        tag.body === "children" ||
        (tag.body === "children-when-expanded" && n.expanded);
      const childLines = emitsChildren ? renderList(n.children).lines : [];
      segments.push({
        head:
          childLines.length === 0
            ? [`${prefix}/>`]
            : [`${prefix}>`, ...indentLines(childLines), `</${tag.name}>`],
        pinnedHead: null,
        headIsTag: true,
        children: EMPTY_LIST,
        hasChildren: false,
      });
    }

    const pinned = pinnedAt(segments);
    const out: string[] = [];
    for (const [index, seg] of segments.entries()) {
      out.push(...(pinned[index] ? seg.pinnedHead! : seg.head));
      out.push(...indentLines(seg.children.lines));
    }
    const last = segments.length - 1;
    return {
      lines: out,
      endsWithTag: last >= 0 && endsWithTag(segments[last]!, pinned[last]!),
    };
  };

  return renderList(forest).lines.join("\n");
}

/**
 * Drop every blank line that sits beside a TAG line (`<name …>`, `<name/>`,
 * `</name>` for a registered tag name) from text an agent WROTE — an
 * `edit_page` `new_string`, a `write_agent_note` body — before it is spliced and
 * parsed.
 *
 * In our dialect a blank line is an empty paragraph, but everyone writing
 * markdown puts one around a card they insert: `</human>\n\n<agent-inline>…`.
 * Read as an empty paragraph, that line was a block minted in the page's own
 * prose, outside the card being written, and the whole edit was refused. Tags
 * sit on lines of their own, so a blank line beside one states nothing a reader
 * can see — here it is spacing.
 *
 * Deliberately a rule for the AGENT'S text, not for the parser: a spacer
 * already on the page must stay a spacer when an agent inserts a card beside
 * it, and only the splice knows which lines the agent wrote. It drops no empty
 * paragraph copied from a read, because the serializer never emits a blank line
 * beside a tag (the pin, {@link pinnedAt}): such a paragraph reads as `<text/>`.
 * Fence bodies (code) are left verbatim.
 */
export function dropBlankLinesBesideTags(
  text: string,
  handles: BlockHandle<unknown>[],
): string {
  const names = new Set(tagParsersOf(handles).keys());
  const lines = text.split("\n");
  const fenced = fenceLines(lines, handles);
  // "tag" | "blank" | "other", per line; a fence's lines are all "other".
  const kinds = lines.map((line, i): "tag" | "blank" | "other" => {
    const content = line.trim();
    if (fenced[i]) return "other";
    if (content === "") return "blank";
    const name = /^<\/?([A-Za-z][\w-]*)/.exec(content)?.[1];
    return name !== undefined && names.has(name) ? "tag" : "other";
  });
  const nearest = (from: number, step: 1 | -1): string | undefined => {
    let i = from;
    while (kinds[i] === "blank") i += step;
    return kinds[i];
  };
  return lines
    .filter(
      (_, i) =>
        kinds[i] !== "blank" ||
        (nearest(i, -1) !== "tag" && nearest(i, 1) !== "tag"),
    )
    .join("\n");
}

/**
 * Which lines of `lines` belong to a fenced block (its open and close lines
 * included) — verbatim bytes the inline syntax never reaches.
 */
function fenceLines(
  lines: readonly string[],
  handles: BlockHandle<unknown>[],
): boolean[] {
  const fences = claimersOf(handles).fences.map((f) => f.fence);
  let fenceClose: string | null = null;
  return lines.map((line) => {
    const content = line.trim();
    if (fenceClose !== null) {
      if (content.startsWith(fenceClose)) fenceClose = null;
      return true;
    }
    const fence = fences.find((f) => content.startsWith(f.open));
    if (fence) fenceClose = fence.close;
    return fence !== undefined;
  });
}

/** One single-backtick inline code span: `` `x` ``, never inside ``` `` ``` runs or after `\`. */
const CODE_SPAN_RE = /(?<![`\\])`([^`\n]+)`(?!`)/g;

/**
 * Drop the backticks around an inline code span holding exactly ONE token of
 * a family that declared `agentCodeSpan: "token"` (a bare id), in text an agent
 * WROTE — before it is spliced and parsed. `` `task-…` `` then lands as the
 * task's chip, as the same id pasted by a person does, instead of a code-marked
 * run that never chips (see `AgentCodeSpan`, `./inline-markdown.ts`).
 *
 * Only spans the write INTRODUCES: a span also present in `replaced` — the text
 * this write replaces (`edit_page`'s `old_string`, the card's current contents
 * for `write_agent_note`) — is left as written, so an edit that carries a
 * person's backticked id along unchanged does not rewrite it (which would be a
 * write to their prose, and refused). Fence bodies are left verbatim, and so is
 * a span holding anything besides the token.
 */
export function unwrapAgentCodeSpans(
  text: string,
  handles: BlockHandle<unknown>[],
  tokens: readonly RegExp[],
  replaced: string,
): string {
  if (tokens.length === 0 || !text.includes("`")) return text;
  const whole = tokens.map(
    (t) => new RegExp(`^(?:${t.source})$`, t.flags.replace("g", "")),
  );
  const lines = text.split("\n");
  const fenced = fenceLines(lines, handles);
  return lines
    .map((line, i) =>
      fenced[i]
        ? line
        : line.replace(CODE_SPAN_RE, (span, content: string) =>
            whole.some((re) => re.test(content)) && !replaced.includes(span)
              ? content
              : span,
          ),
    )
    .join("\n");
}
