import { z } from "zod";
import { RankSchema } from "@plugins/primitives/plugins/rank/core";
import { StoredBlockDataSchema } from "@plugins/page/plugins/block-entity/core";
import { EmojiSchema } from "@plugins/ui/plugins/icons/plugins/emoji/core";
import { defineBlock, type BlockAuthor } from "./define-block";
import type { BlockMarkdown } from "./markdown";

// A block is the single node type. A page is just a block of `type="page"` whose
// `data` is `{ title, icon }`; content blocks carry their own payload in `data`.
// `pageId` is the denormalized nearest `type="page"` ancestor (null for a page
// at the tree root).
export const BlockSchema = z.object({
  id: z.string(),
  pageId: z.string().nullable(),
  parentId: z.string().nullable(),
  type: z.string(),
  data: z.unknown(),
  rank: RankSchema,
  expanded: z.boolean(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Block = z.infer<typeof BlockSchema>;

// A page row as the `pagesTree` set serves it: a `type="page"` block plus
// `docRank` — its place in its SIDEBAR group.
//
// `rank` is the storage key: a fractional index comparable ONLY within its own
// `(parent_id, rank)` space. The sidebar's sibling group is "pages sharing a
// `pageId`", which can span SEVERAL such spaces (a sub-page may be a direct
// child of its page, or sit under a text line / toggle), so sorting those `rank`
// strings against each other is meaningless — and duplicates across spaces make
// the DnD rank arithmetic throw. `docRank` is a real fractional-index `Rank`,
// unique and ordered WITHIN one `pageId` group, in true document order (a
// rank-ordered DFS of the block forest, stopping at nested pages).
//
// It is PERSISTED — `page_blocks.doc_rank` — and WRITER-DERIVED: the
// structural-write chokepoint (`withPageForest`) re-mints it for exactly the
// groups a write touched, keeping every key that still fits, so a reorder is an
// ordinary write of the rows that moved. (It used to be minted afresh per load,
// which is why it once could not be stored: a per-load key was valid only
// against the group it was minted with. A maintained column has no such
// window.) It is still **never written into `rank` and never in a request
// body**: no client mints one, and moves send positional intent (an anchor id)
// while the server mints the real `rank` against the complete sibling set. The
// SAME row read through `pageBlocks` carries no `docRank` — that resource orders
// by `rank`, within one `(parent_id, rank)` space, where it is meaningful.
//
// `editedAt` is when the page was last EDITED: the newest `updatedAt` over the
// page row and its live content (every live block whose nearest page is this
// one, sub-page rows included). The row's own `updatedAt` moves only on a
// rename, a cover or a kind change — a content edit stamps only the edited
// block's row — so a "recently edited" surface reads `editedAt`. Served from a
// trigger-maintained rollup (`../server/internal/rollup-spec.ts`), so a content
// write refills its page's one row. The header's "Edited" label, the sidebar's
// Recent section and the Welcome page's Recent pages all read this field.
export const PageRowSchema = BlockSchema.extend({
  // Narrower than a block's `unknown`: a page row is read straight off the
  // `page_blocks` entity, whose `data` field decodes through this schema.
  data: StoredBlockDataSchema,
  docRank: RankSchema,
  editedAt: z.coerce.date(),
});
export type PageRow = z.infer<typeof PageRowSchema>;

// The reserved block type for a page node.
export const PAGE_BLOCK_TYPE = "page";

// The `infra/trash` source id this plugin registers (`defineTrashSource` in
// server/index.ts). It lives in `core/` — NOT privately on the server — because
// both sides name it: the server chokepoint stamps it onto every ledger row, and
// the web (the Pages Trash dialog, the undoable-delete seam) addresses
// `/api/trash/:sourceId/…` with it. One name per concept.
export const PAGES_TRASH_SOURCE = "pages";

// The SECOND `infra/trash` source this plugin registers: the anchor entry a
// delete operation with no page root mints for its content rows (every block
// delete is a trash — `research/2026-09-09-page-data-based-text-undo-entries-v2.md`
// §3). One entry per gesture, so one Cmd+Z restores it; the Pages Trash dialog
// subscribes to `PAGES_TRASH_SOURCE` only, so these never appear there. Named
// here for the same reason as its sibling: the undoable-delete seam on the web
// addresses `/api/trash/:sourceId/…` with whatever source the server answered.
export const PAGE_BLOCKS_TRASH_SOURCE = "page-blocks";

// A page cover: either an uploaded image (stored as an attachment id + a
// vertical reposition offset, applied as object-position Y%) or a preset
// gradient (stored as a frozen preset id, resolved to CSS client-side). The
// discriminated `type` keeps the two variants exclusive.
export const PageCoverSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("image"),
    attachmentId: z.string(),
    positionY: z.number().min(0).max(100).default(50),
  }),
  z.object({ type: z.literal("gradient"), preset: z.string() }),
]);
export type PageCover = z.infer<typeof PageCoverSchema>;

// The `data` payload of a `type="page"` block. `icon` is the page's emoji
// (exactly one RGI emoji grapheme, `EmojiSchema`), drawn as a text glyph by
// `<PageIcon>`; null = no icon (the default document glyph is shown instead). `cover` is the optional page cover
// (absent on legacy rows — decodes to `undefined`, no data migration).
// `author: "agent"` marks an AGENT-AUTHORED page — a sub-page whose whole
// content an agent may write (`<agent-page>` in markdown). Absent means the
// human's, the fail-safe reading, exactly as for every block that declares no
// author; it is read through `blockAuthorOf` (`pageBlockAuthor` below), never
// directly. The marker is the page's KIND, changed only by the `setPageKind`
// op: the server refuses a data write that flips it (`rewriteBlockData`). Not
// to be confused with `apps/pages/agent-origin`'s "agent pages" (e2e-created, swept after 24h) —
// see research/2026-09-11-page-agent-pages.md.
//
// `instructions: true` marks an INSTRUCTIONS page — the human's standing
// instructions to every agent working under the page it sits in
// (`<instructions-page>` in markdown; research/2026-09-17-page-agent-instructions.md),
// and `global: true` on one says they are handed to every conversation at its
// start. Both keys, with `author`, are the page's KIND (`pageKindOf`), changed
// only by the `setPageKind` op. The two kinds are exclusive and `global` belongs
// to an instructions page alone — `pageBlockAuthor.refine` states that, because a
// zod 3 `.refine` would turn this object into a schema without `.shape`.
//
// Flat keys rather than `instructions: { global }`, deliberately: a markdown
// spelling is selected by a PRESET of literal discriminator values
// (`BlockTag.spellings`), so `instructions: true` is what `<instructions-page>`
// can be chosen by, where a nested object could not be.
export const PageDataSchema = z.object({
  title: z.string(),
  icon: EmojiSchema.nullable(),
  cover: PageCoverSchema.nullable().optional(),
  author: z.literal("agent").optional(),
  instructions: z.literal(true).optional(),
  global: z.boolean().optional(),
});
export type PageData = z.infer<typeof PageDataSchema>;

/**
 * What a page IS to the agents working on it — the three kinds a page row can
 * be, as one value. Stored as flat keys on `PageData` (`author`,
 * `instructions`, `global`); this is the one reading and the one writing of
 * those keys ({@link pageKindOf} / {@link withPageKind}), so no writer can set
 * one and forget the others.
 *
 * - `page` — an ordinary page, the human's;
 * - `agent-page` — an agent may write all of it (`<agent-page>`);
 * - `instructions` — the human's standing instructions to agents working under
 *   the parent page (`<instructions-page>`); `global` hands them to every
 *   conversation at its start.
 */
export const PageKindSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("page") }),
  z.object({ kind: z.literal("agent-page") }),
  z.object({ kind: z.literal("instructions"), global: z.boolean() }),
]);
export type PageKind = z.infer<typeof PageKindSchema>;

/** The stored keys that together say a page's {@link PageKind}. */
const PAGE_KIND_KEYS = ["author", "instructions", "global"] as const;

/** A page's kind, read off its data. */
export function pageKindOf(
  data: Pick<PageData, "author" | "instructions" | "global">,
): PageKind {
  if (data.instructions === true) {
    return { kind: "instructions", global: data.global === true };
  }
  if (data.author === "agent") return { kind: "agent-page" };
  return { kind: "page" };
}

/** Whether two kinds are the same kind (and, for instructions, the same `global`). */
export function samePageKind(a: PageKind, b: PageKind): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind !== "instructions" || a.global === (b as typeof a).global;
}

/**
 * `data` with its kind keys replaced by `kind`'s, every other key copied
 * verbatim. An ordinary page carries none of the keys (every page a human ever
 * made was stored without them), and `global` is written only when true.
 */
export function withPageKind(
  data: Readonly<Record<string, unknown>>,
  kind: PageKind,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...data };
  for (const key of PAGE_KIND_KEYS) delete next[key];
  if (kind.kind === "agent-page") next.author = "agent";
  if (kind.kind === "instructions") {
    next.instructions = true;
    if (kind.global) next.global = true;
  }
  return next;
}

// Parse a page block's `data` into its typed `{ title, icon }`. Use on rows
// known to be `type="page"`. Only the `data` field is read, so any row-like
// value carrying `data` is accepted (raw DB selects, full Blocks, etc.).
export function pageData(block: Pick<Block, "data">): PageData {
  return PageDataSchema.parse(block.data);
}

/**
 * The attributes `<agent-page>` accepts. `id` is not among them because the
 * parse lifts it off as the node's `ref` before these are read.
 */
const AGENT_PAGE_ATTRS = new Set(["title"]);

/** The attributes `<instructions-page>` accepts (`id` is lifted off first). */
const INSTRUCTIONS_PAGE_ATTRS = new Set(["title", "global"]);

/**
 * The `page` row's markdown mapping, declared ONCE and shared by BOTH handles
 * that register the type — `pageBlockHandle` below (server `Editor.BlockData`)
 * and `sub-page`'s web renderer handle. A second copy would let the two disagree
 * about the tag name, and two handles claiming one tag name on PARSE is a loud
 * error.
 *
 * Two spellings of one row type, chosen by `data.author` (`BlockTag.spellings`):
 *
 * - `<page id="…" title="…"/>` — a human's sub-page. Serialize-only: the same
 *   line is how a link-to-page block writes itself, and `page-link` claims it
 *   on parse.
 * - `<agent-page id="…" title="…"/>` — an agent-authored page. Claimed on parse,
 *   and the ONE way a markdown parse mints a sub-page: its tagless mint form
 *   `<agent-page title="…">body</agent-page>` becomes a new `page` node carrying
 *   `author: "agent"` and its body. Minting a human's sub-page stays
 *   turn-into-page's alone.
 *
 * `title` rides both, for two reasons that come to one: an agent must be able to
 * tell pages apart without opening each one. On `<agent-page>` it is the row's
 * own data, emitted by the spelling's `attrs` and kept by its parse (the mint
 * form needs it; the planner ignores it on a pointer, comparing only the
 * spelling's preset). On `<page>` it is an `annotated` attribute — read-only,
 * discarded on parse — because `page-link` shares that tag and a link's title
 * lives on another row; `editor/server` and `page-link/server` supply it.
 */
export const pageBlockMarkdown: BlockMarkdown<PageData> = {
  tag: {
    name: "page",
    // A sub-page's children live under a DIFFERENT `page_id` partition and are
    // mounted only while the row is expanded (`deriveMounts`), so a collapsed
    // page's children are not in the forest at all. Emitting `<page id="x"/>`
    // for it states that, and stops a future server-side walk from loading rows
    // the editing surface never had.
    body: "children-when-expanded",
    // A page's identity IS its row id, which no `data` field carries — this is
    // the one tag that reads `ctx.id`, and why the serialize walk takes
    // `MarkdownNode` rather than the id-less `SerializedBlock`.
    attrs: (_data, ctx) => {
      if (ctx.id === undefined) {
        throw new Error(
          "markdown: a `page` block can only be serialized from an IDENTIFIED forest — " +
            "its id is its identity, and an id-less <page/> could never be reconciled " +
            "against the row it came from.",
        );
      }
      return { id: ctx.id };
    },
    // Read-only, supplied from outside the walk — see the doc above. Declared on
    // `page-link`'s tag too, so the two halves of `<page>` read the same.
    annotated: ["title"],
    // SERIALIZE ONLY: `<page id="x"/>` parses back as a `page-link`, never as a
    // human's sub-page — minting one means minting its `page_id` partition and
    // restamping a subtree, which the server's turn-into-page op does. The id in
    // the tag is what lets a markdown apply reconcile the pointer against the
    // EXISTING sub-page row instead of re-minting it.
    serializeOnly: true,
    spellings: [
      {
        name: "agent-page",
        data: { author: "agent" },
        // The row id, as every agent-facing card carries one: `read_page`'s
        // pointer is the id an agent passes back as `block_id` to write the
        // page's content, and what a later apply pins the row by.
        identified: true,
        body: "children-when-expanded",
        attrs: (data) => ({ title: data.title }),
        // Only `title`, and loudly. A pointer's content is the page's own, so
        // any other attribute on it would be an edit the planner has no way to
        // honour — and on the mint form an icon or a cover is not something an
        // agent can author through markdown yet.
        parseAttrs: (attrs) => {
          for (const name of Object.keys(attrs)) {
            if (!AGENT_PAGE_ATTRS.has(name)) {
              throw new Error(
                `markdown: <agent-page> takes only \`title\` (and \`id\` on a pointer), but was ` +
                  `given \`${name}\`. A page's content lives in the page itself: to change an ` +
                  "existing agent page, pass its id as `block_id` and write its content there.",
              );
            }
          }
          return { title: attrs.title ?? "", icon: null };
        },
      },
      {
        // An instructions page: the human's standing instructions to agents
        // working under the page it sits in. Emitted with its id (the pointer an
        // agent reads it by) and `global` when it is delivered to every
        // conversation at start.
        name: "instructions-page",
        data: { instructions: true },
        identified: true,
        // Its words are the human's (`pageBlockAuthor`), so no agent mints one:
        // the tagless form is refused at the parse, before any plan. A pointer
        // WITH its id still reads back, which is what lets an agent echo the
        // page's row unchanged while editing the page around it.
        pointerOnly: {
          reason:
            "An instructions page holds a person's standing instructions to agents, so only a " +
            "person creates one, from the page editor. To leave notes for the page's author, " +
            "write an <agent-inline> card instead.",
        },
        body: "children-when-expanded",
        attrs: (data) => ({
          title: data.title,
          global: data.global === true ? "true" : undefined,
        }),
        // A pointer's content is the page's own, so a changed title or `global`
        // on it is not an edit the planner honours (it compares only the
        // spelling); both are parsed only so the payload is a valid page.
        parseAttrs: (attrs) => {
          for (const name of Object.keys(attrs)) {
            if (!INSTRUCTIONS_PAGE_ATTRS.has(name)) {
              throw new Error(
                `markdown: <instructions-page> takes only \`id\`, \`title\` and \`global\`, but was ` +
                  `given \`${name}\`. Hand the pointer back exactly as read_page showed it.`,
              );
            }
          }
          const global = attrs.global;
          if (global !== undefined && global !== "true" && global !== "false") {
            throw new Error(
              `markdown: <instructions-page global="${global}"> — \`global\` is "true" or absent.`,
            );
          }
          return {
            title: attrs.title ?? "",
            icon: null,
            ...(global === "true" ? { global: true } : {}),
          };
        },
      },
    ],
  },
};

/**
 * The `page` row's author declaration, shared by both handles for
 * `pageBlockMarkdown`'s reason: an agent-authored page is `data.author ===
 * "agent"`, and every other page — `author` absent — is the human's. The per-row
 * twin of an annotation's static `author` (`BlockHandle.authorFromData`).
 */
export const pageBlockAuthor = {
  // An instructions page declares the HUMAN explicitly, where an ordinary page
  // declares nothing: the write walk stops at the nearest row that declares
  // anything, so this is what keeps an instructions page nested inside an
  // agent-authored page closed to the agent writing that page.
  authorFromData: (data: Partial<PageData>): BlockAuthor | undefined =>
    data.instructions === true ? "human" : data.author,
  // The kinds are exclusive, and `global` belongs to an instructions page — the
  // invariant `PageDataSchema` cannot state (see there). `BlockHandle.refine`.
  refine: (data: PageData, ctx: z.RefinementCtx): void => {
    if (data.instructions === true && data.author !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["instructions"],
        message:
          "a page is an agent-authored page or an instructions page, never both — " +
          "instructions are the human's words",
      });
    }
    if (data.global !== undefined && data.instructions !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["global"],
        message: "`global` belongs to an instructions page only",
      });
    }
  },
};

// The block handle for the reserved `type="page"` node. Owned by `editor/core` —
// NOT by the `sub-page` renderer plugin — because `handle-turn-into-page` and
// `restorePageContent` write page rows directly, so page creation must not depend
// on the sub-page plugin being enabled. `editor/server` contributes THIS handle to
// the server `Editor.BlockData` registry; the `sub-page` web renderer declares its
// own handle for the same type, sharing `pageBlockMarkdown` and `pageBlockAuthor`
// above.
export const pageBlockHandle = defineBlock({
  type: PAGE_BLOCK_TYPE,
  schema: PageDataSchema,
  markdown: pageBlockMarkdown,
  ...pageBlockAuthor,
});
