import { createElement, useMemo, type ComponentType } from "react";
import {
  defineSlot,
  defineSlotFacade,
} from "@plugins/framework/plugins/web-sdk/core";
import {
  defineDispatchSlot,
  defineOrderedDispatchSlot,
  defineRenderSlot,
  type OrderedDispatchContribution,
} from "@plugins/primitives/plugins/slot-render/web";
import type { Block, BlockHandle, RichText } from "../core";
import type {
  BlockAnchorProps,
  BlockChrome,
  BlockEditorAPI,
  BlockFootProps,
  BlockFrameProps,
  BlockRendererProps,
  InsertAction,
} from "./types";
import { UnknownBlock } from "./components/unknown-block";
import { BlockTextRenderer } from "./components/block-text-renderer";

/**
 * Where the caret lives for a text-less block type — one that owns no editable
 * text, so nothing on screen blinks to say the caret is on it and no Lexical
 * instance registers a focus handle for it.
 *
 * There is deliberately **no third value meaning "nowhere"**. That state used to
 * exist as the absence of any declaration, and eight block types were in it:
 * image, video, audio, file, embed, bookmark, place and page-link registered no
 * focus handle at all, so `navigate()` — which walks the registered handles —
 * skipped straight over them. A user arrowing down a page jumped from the
 * paragraph above an image to the paragraph below it, while a click could still
 * focus parts of the same block, leaving the browser and the editor disagreeing
 * about where the user was. Nothing anywhere could say so, because forgetting
 * looked exactly like a block that had nothing to declare.
 */
export type BlockCaretPlacement =
  /**
   * The EDITOR mounts the caret host around this block's row. The renderer
   * writes no caret code at all: it is focusable, arrow-navigable, paints the
   * caret cue, and answers Backspace and Enter, for free. This is the answer for
   * every block whose content is an object the user looks at rather than types
   * into — all the media types, and the fallback for a type the editor does not
   * recognise.
   */
  | "editor"
  /**
   * The RENDERER registers its own handle through `useVoidCaret`, because it
   * owns the thing that must hold the caret and the editor cannot know what that
   * is: a `<textarea>` of source (code, equation), or a `Row`'s inner control,
   * which `Row` re-synthesizes the moment the row grows actions (sub-page).
   */
  | "renderer";

/** Block handle metadata carried alongside the dispatch fields (match, component). */
export interface BlockMeta {
  block: BlockHandle<unknown>;
  /**
   * Per-type presentation for a text-bearing type, applied by the shared
   * renderer onto a fixed element tree. Mutually exclusive with `component` —
   * see `BlockRegistration`.
   */
  chrome?: BlockChrome;
  /**
   * Where this text-less type's caret lives. Optional as STORED and required at
   * the write site, the same shape `chrome` has — see `BlockRegistration`, which
   * is where the requirement is expressed.
   */
  caret?: BlockCaretPlacement;
  /**
   * A text-less type's STATIC rendering, for surfaces that mount no editor (the
   * read-only renderer: version history, the public site). Already bound to the
   * handle — it takes the stored `data` as `unknown` and parses it through
   * `block.parse` before the registered component sees it — so a reader
   * renders it without naming the type or knowing its shape. See
   * `BlockRegistration`'s text-less arm, where it is written typed.
   */
  view?: BlockView;
}

/** A block type's static rendering as STORED: bound to its handle's `parse`. */
export type BlockView = ComponentType<{ data: unknown }>;

/**
 * Bind a typed static view to its handle: the stored component parses `data`
 * through the handle, so the registered one only ever sees the type's own
 * shape. `parse` throws on data the schema rejects — the same loud failure the
 * editable renderer's own `handle.parse(block.data)` gives.
 */
function bindView<T>(
  handle: BlockHandle<T>,
  View: ComponentType<{ data: T }>,
): BlockView {
  function BoundBlockView({ data }: { data: unknown }) {
    return createElement(View, { data: handle.parse(data) });
  }
  BoundBlockView.displayName = `BlockView(${handle.type})`;
  return BoundBlockView;
}

/**
 * Full contribution shape as STORED — block metadata plus ordered-dispatch
 * fields, `component` always resolved. What a plugin may WRITE is narrower; see
 * `BlockRegistration`.
 */
export type BlockContribution = OrderedDispatchContribution<
  BlockRendererProps,
  string
> &
  BlockMeta;

/** Dispatch fields every block registration carries. */
interface BlockRegistrationBase {
  id: string;
  match: string | RegExp | ((props: BlockRendererProps) => boolean);
}

/**
 * The compile-time discriminator between the two arms below. `defineBlock`
 * installs a REQUIRED `text` lens exactly when the schema carried the
 * `TextBearingSchema` brand, and types a void block's as `text?: undefined` — so
 * "does this block carry editable text" is readable from the handle's TYPE, with
 * no second flag to keep in sync. `data: never` only has to be a bottom type the
 * concrete lens is bivariantly assignable to; nothing calls it through here.
 */
type TextBearingHandle = BlockHandle<unknown> & { text(data: never): RichText };
type TextLessHandle<T = unknown> = BlockHandle<T> & { text?: undefined };
/**
 * A container ANCHOR, the one text-less shape that renders no LINE of its own —
 * `BlockRow` returns before the dispatch for it, so it has no row for a caret to
 * land on and its children hold the caret instead.
 *
 * The proof comes from `defineContainerBlock`, whose return type states
 * `anchor: true` as a certainty. The handle's own field is `anchor?: true` (i.e.
 * `true | undefined`), which no amount of setting it by hand can narrow — so
 * this arm is inhabitable only by a type that went through the factory that
 * makes it a container. That is deliberately the same trick `audience` uses to
 * prove a block went through `defineAnnotationBlock`.
 */
type AnchorHandle = TextLessHandle & { anchor: true };

/**
 * What a plugin writes at an `Editor.Block` call site — a union with exactly one
 * inhabitable arm per handle:
 *
 * - **text-bearing** (text, headings, lists, to-do, toggle, quote, prompt) → the
 *   SLOT supplies the renderer; the contribution may only declare `chrome`.
 *   Naming a `component` here is a compile error, and that is the point: quote
 *   and prompt used to own their own dispatch components, so converting into
 *   them unmounted the `LexicalComposer` (and the Yjs↔Lexical binding) holding
 *   the user's caret — the reason the `/quote` bug was reported for those types
 *   and no other. Every text type now dispatches ONE function reference, so
 *   every text↔text conversion reconciles in place. See
 *   `research/2026-07-29-page-text-block-presentation-api.md`.
 * - **text-less** (divider, image, code-block, embed, media, sub-page, the
 *   callout anchor, …) → owns its component outright. Converting text → divider
 *   SHOULD tear the editor down; there is no caret on the other side to keep.
 *
 * **`excludeFromReorder` is on the TEXT-LESS arm only**, and that is a real hole
 * being closed rather than hygiene: `ReorderItemMiddleware`
 * (`plugins/reorder/web/internal/dnd-item-middleware.tsx`) early-returns
 * `<>{children}</>` where it otherwise renders `<SortableReorderItem>`,
 * discriminating on exactly that field — an element-type flip on an ANCESTOR of
 * the composer, keyed per contribution. A text-bearing type setting it would
 * remount Lexical on every conversion into or out of it: the reported bug,
 * reached through a field the union would otherwise permit. No block sets it
 * today, which is why the shared-renderer fix would otherwise be complete in
 * fact rather than by construction.
 */
export type BlockRegistration<T = unknown> =
  | (BlockRegistrationBase & {
      block: TextBearingHandle;
      chrome?: BlockChrome;
      component?: never;
      caret?: never;
      view?: never;
      excludeFromReorder?: never;
    })
  // A container anchor: no line, so no caret to place. Listed BEFORE the general
  // text-less arm so a container matches it rather than being asked for a
  // `caret` it could not honour.
  | (BlockRegistrationBase & {
      block: AnchorHandle;
      component: ComponentType<BlockRendererProps>;
      chrome?: never;
      caret?: never;
      view?: never;
      excludeFromReorder?: boolean;
    })
  | (BlockRegistrationBase & {
      block: TextLessHandle<T>;
      component: ComponentType<BlockRendererProps>;
      chrome?: never;
      /**
       * REQUIRED, and that is the whole point: a text-less block type has no
       * editable text to hold the caret, so *something* has to, and there is no
       * longer any way to leave the question unanswered. See
       * {@link BlockCaretPlacement} for the two answers and for the eight block
       * types that silently had neither.
       */
      caret: BlockCaretPlacement;
      /**
       * The type's static rendering, for surfaces that mount no editor (see
       * {@link BlockMeta.view}). Typed against the handle's OWN data — the
       * slot binds it to `block.parse`, so the component never sees a raw blob.
       * Optional: a type without one renders as the read-only surface's
       * placeholder card.
       */
      view?: ComponentType<{ data: T }>;
      excludeFromReorder?: boolean;
    });

// Ordered-dispatch: renders one contribution per block via `.Dispatch`, but
// each contribution carries an `id` so the slot enters the reorderable-slots
// manifest and owes an authored config override. The grouped block menus read
// that config order (groups + labels) through `useReorderedEntries`; the slot
// itself stays pure single-match dispatch.
const blockSlot = defineOrderedDispatchSlot<
  BlockRendererProps,
  string,
  BlockMeta
>({
  key: (props) => props.block.type,
  fallback: UnknownBlock,
  docLabel: (c) => c.block?.type,
});

/**
 * Extra fields carried alongside a container frame's dispatch fields.
 *
 * Both ride on the frame registration rather than getting slots of their own on
 * purpose: containerhood is already derived from *who actually paints a box*
 * (`useIsFramedBlock`), precisely so it cannot drift from a second flag; a
 * separate anchor (or menu) slot would reintroduce exactly that drift in a new
 * coat — a type could claim a decoration while framing nothing, or frame
 * without one.
 *
 * The two are **different surfaces of one container**, and the split is the
 * user's stated model:
 *
 * - `anchor` / `cornerAnchor` is the container's decoration, rendered by the
 *   surface in the ROW layer — see `BlockAnchorProps`. It is the container's
 *   APPEARANCE affordance, and the two spellings are its two SEATS (below).
 * - `menu` is contributed sections inside the rail popover the container owns on
 *   its BORROWED line (`BlockActionsMenu`'s container arm) — where the
 *   STRUCTURAL actions (Collapse, Remove, Delete) live. A container with nothing
 *   per-instance to configure (the context card, whose payload is `{}`)
 *   contributes none and still gets those actions, so this field says nothing
 *   about containerhood.
 *
 * Appearance is deliberately reachable from BOTH: the same component renders in
 * the glyph's popover and in the rail's menu. The rail is where a user looks for
 * block actions; the glyph is where they look for the glyph.
 *
 * The honest cost: only a field literally named `component` goes through the
 * framework's sealed-component middleware chain (error boundary, reorder), so an
 * `anchor`/`menu` component is UNSEALED — a crash inside it is not contained to
 * the slot. Precedent: `BlockHandle.icon` is rendered raw today. Documented, not
 * discovered.
 */
export type BlockFrameMeta = BlockFrameDecoration & {
  /**
   * Which blocks of the matched type are containers. Absent: every one. A pure
   * function of the block's own row — `type`, `data` and the fold — so every
   * surface answers it from the forest it already holds, the read-only one
   * included, with no read of its own.
   *
   * For a type that is a container only in some STATES: an agent-authored
   * sub-page is a card while it is expanded inline (its content is the agent's,
   * so the wash must cover it) and a plain row while collapsed. It is read
   * wherever membership is: the spans, and so every pad, inset, foot and
   * rail-seat count derived from them. A block it answers no for is exactly an
   * unframed block — no box, no pad, its subtree flat.
   */
  applies?: (block: FrameCandidate) => boolean;
  /**
   * How far this container's CONTENT sits from the box it paints — see
   * `FramePad`. REQUIRED: the surface is the only thing that can make the space
   * (the frame is a backdrop and cannot displace a row), and only the container
   * knows whether its mark is a box that needs clearing or a rule that does not.
   */
  pad: FramePad;
  /**
   * Sections this container contributes to the rail popover, above the generic
   * structural actions. The prop shape is `Editor.TurnInto`'s verbatim, so
   * "menu sections contributed by a plugin" is ONE convention in this editor
   * rather than two that drift.
   */
  menu?: ComponentType<{
    block: Block;
    api: BlockEditorAPI;
    close: () => void;
  }>;
  /**
   * A strip of this container's own chrome at the BOTTOM of its box — below the
   * last visible child, inside the card's padding. See `BlockFootProps`.
   *
   * Deliberately NOT a third arm of `BlockFrameDecoration`, and the distinction
   * is the whole reason it is a separate field. A decoration answers *what is
   * this box*: it is appearance only and reserves no space, which is why a
   * container may have exactly one and why the union makes "two of them"
   * unspellable. A foot is chrome the box MAKES ROOM FOR — its height is its
   * own, the rows around it move for it, and the card's bottom pad is pushed
   * below it (`internal/frame-foot.ts`). Two different questions; folding the
   * second into the first would force a container to choose between having a
   * name and having a foot.
   *
   * Keeping it off the union is also what keeps `./singularity check
   * page-editor:anchor-has-decoration` meaning what it means today: a container
   * still owes exactly ONE decoration, and a foot is never one — a card with a
   * foot and no decoration is still an invisible card.
   */
  foot?: ComponentType<BlockFootProps>;
};

/**
 * What a frame's `applies` may read: the row facts every surface holds — the
 * editable forest's `Block` and the read-only renderer's node alike.
 */
export interface FrameCandidate {
  type: string;
  /** Optional, as on both `Block` and the read-only node (absent reads as `{}`). */
  data?: unknown;
  expanded: boolean;
}

/**
 * A container's decoration and, by which field it is spelled, its SEAT. Exactly
 * one of the two, because a container has exactly one decoration — and the
 * union is what makes "both" and "an appearance with no seat" unspellable,
 * rather than a `seat: "gutter" | "corner"` flag that could name a seat for a
 * component nobody supplied.
 *
 * - **`anchor` — the gutter glyph.** A `BLOCK_INDENT`-wide column at the box's
 *   own left inset, seated on the FIRST VISIBLE CHILD's borrowed first line, so
 *   the mark and that line read as one. What a callout's icon is: a mark the
 *   author chose, which is the content of the card's identity, so it is always
 *   there and it leads the text.
 * - **`cornerAnchor` — the card's name, in the box's top-right corner.** Hidden
 *   until the pointer is inside the card, floating OVER the content (it
 *   reserves no space and shifts nothing). What the annotation family's type
 *   name is: not content, just an answer to "what is this box?" — worth nothing
 *   at rest and worth exactly one glance on demand.
 *
 * Which one a container reaches for is a statement about what its decoration IS,
 * which is why it is spelled here and not configured: an annotation is NAMED, a
 * callout is DRAWN, and that replaced the dashed-vs-solid border as the thing
 * that tells the two families apart.
 */
export type BlockFrameDecoration =
  | { anchor?: ComponentType<BlockAnchorProps>; cornerAnchor?: never }
  | { cornerAnchor: ComponentType<BlockAnchorProps>; anchor?: never };

/**
 * What a container's box does to the geometry around it: whether it holds its
 * content off its own edges, and whether it reclaims its children's indent step
 * to pay for that. See `FRAME_PAD_X` for why the second is not simply the first.
 */
export interface FrameGeometry {
  /** `pad: "box"` — one `FRAME_PAD` on all four sides. */
  pads: boolean;
  /**
   * …and the column that pad comes out of is free, so a framed row's content
   * edge pulls back by `BLOCK_INDENT - FRAME_PAD_X`. False for a container whose
   * gutter GLYPH stands in that column.
   */
  absorbs: boolean;
}

/**
 * Whether the box a container paints holds its content OFF its edges.
 *
 * - **`"box"`** — one `FRAME_PAD_X` / `FRAME_PAD_Y` on all four sides. What a
 *   FILLED shape needs: a callout's tint, an annotation card's wash. Text
 *   landing on the edge of its own fill reads as a clipping bug, and that is
 *   exactly what every one of them did before this field existed.
 * - **`"rule"`** — no pad at all. What a container that paints no BOX needs:
 *   the quote's left bar has no right edge and no top edge to clear, so a pad
 *   would only narrow the passage and grow the bar past the text it marks. The
 *   gap between the bar and the first letter is `BLOCK_INDENT`, which the
 *   quote's children already have and which nothing here adds to.
 *
 * The name says what the container DRAWS, not what it wants numerically — which
 * is what makes a new container's answer obvious from looking at it.
 */
export type FramePad = "box" | "rule";

/** Where the surface seats a container's decoration. */
export type BlockDecorationSeat = "gutter" | "corner";

/** A container's decoration, resolved with the seat it asked for. */
export interface BlockDecoration {
  component: ComponentType<BlockAnchorProps>;
  seat: BlockDecorationSeat;
}

export const Editor = {
  /**
   * Register a block type's renderer. Callable + the slot's own members
   * (`id` / `useContributions` / `Dispatch`), so it stays slot-shaped for the
   * facet walk and every reading consumer; only the CALL signature is narrowed,
   * to `BlockRegistration`'s union.
   */
  Block: defineSlotFacade(
    <T>(reg: BlockRegistration<T>) =>
      blockSlot({
        ...reg,
        // Only the text-less arm may carry a `view` (the other two type it
        // `never`), so its `block` is that arm's `TextLessHandle<T>`.
        view: reg.view
          ? bindView(reg.block as TextLessHandle<T>, reg.view)
          : undefined,
        // The one and only binding of the shared text renderer to a block type.
        // A text-bearing registration cannot name a `component` (typed `never`),
        // so this default is unconditional for all of them — which is precisely
        // what keeps a type change chrome-only.
        component: reg.component ?? BlockTextRenderer,
      } as BlockContribution),
    blockSlot,
  ),
  /**
   * A block type's CONTAINER FRAME: the decorated box painted around the
   * container's own row PLUS its whole visible subtree (the callout's tint).
   * Contributing here is what makes a block type a container — the surfaces
   * derive the framed-type set from this slot's registered matches
   * (`useIsFramedBlock`), so there is no second "I am a container" flag to
   * drift from it.
   *
   * Deliberately NOT a fallback dispatch: a type with no contribution is not
   * framed at all and its subtree stays flat, so `.Dispatch` is only ever
   * rendered for a type known to match. `match` must be a plain string (the
   * block type) — the membership set is read off it, so a RegExp or predicate
   * contribution would paint but never be grouped.
   */
  BlockFrame: defineDispatchSlot<BlockFrameProps, string, BlockFrameMeta>({
    key: (props) => props.type,
    docLabel: (c) => (typeof c.match === "string" ? c.match : undefined),
  }),
  /**
   * Extra "Turn into" targets in the block-actions menu, contributed by plugins
   * that span more than the editor can know — a server-backed transition such
   * as turn-into-page, which turns the block into a sub-page in place,
   * re-partitioning its subtree. Rendered inside the menu's "Turn into"
   * section, only on a `serverSync` editor and never on the zoom root. The
   * contribution receives the block, its editor API, and a `close` callback.
   *
   * `from` says which blocks the target is offered on:
   *
   * - **absent** — every ordinary (non-container) block, beside the block-type
   *   list (turn-into-page's "Page");
   * - **a block type** — blocks of that type ONLY, in either arm of the menu. On
   *   a void CONTAINER this is the only "Turn into" there is: the container
   *   owns no text, so a type conversion has nowhere to put its children, but
   *   a target written for that container type knows what to do with them (the
   *   agent card's "Agent page", whose first line becomes the page's title).
   */
  TurnInto: defineRenderSlot<{
    from?: string;
    component: ComponentType<{
      block: Block;
      api: BlockEditorAPI;
      close: () => void;
    }>;
  }>(),
  /**
   * Extra rows in the block-actions menu's LAST section, ahead of "Copy block
   * ID" — actions ON a block that are neither a conversion nor structural (e.g.
   * open-as-page, which opens the block in a view of its own). Rendered for
   * both arms of the menu, ordinary blocks and containers alike, and only on a
   * `serverSync` editor, like `TurnInto`: a block of an in-memory document has
   * no row anything outside the editor could act on.
   *
   * No `api`, deliberately: an item that edits the block belongs in a section
   * that says so. An item that must know where it is renders inside the editor
   * and can read `useEditorScope()` (e.g. to hide itself on the zoom root). It
   * owns its own commit, and calls `close` when done.
   */
  BlockMenuItem: defineRenderSlot<{
    component: ComponentType<{ block: Block; close: () => void }>;
  }>(),
  /**
   * Toolbar controls for the floating selection format bar. Each contribution
   * renders one control (typically a `<MarkButton/>` reading `useFormatToolbar()`
   * for live active state). The bar is rendered by `FormatToolbarPlugin` only when
   * a non-collapsed range selection exists; contributions never see the editor
   * directly — they dispatch Lexical commands through the context. Reorder
   * middleware applies automatically (the bar is reorderable, by design).
   */
  FormatAction: defineRenderSlot<{ component: ComponentType }>(),
  /**
   * Insert-menu entries (`/` and the gutter `+`) that RUN something rather than
   * convert the caret's line into a block type — for what a type conversion
   * cannot express, e.g. turning the line into a server-created kind of page.
   * Listed among the block types (placed by `after`) and ranked against them by
   * the same `/` query filter; committing one consumes the query text exactly
   * as a block type does, then calls `run` on the caret's line.
   *
   * Offered only on a server-synced editor with an unrestricted palette: the
   * same gate the block-actions menu puts on `TurnInto` ("none of that exists
   * without rows"), plus the `enabledBlockTypes` allowlist, which curates
   * exactly what an editor offers and so never lists an action. And only once
   * the server holds the caret's line (see `useInsertMenuSections`).
   *
   * A plain slot: the order users curate is the block menu's config, which
   * places block types; an action places itself relative to one (`after`).
   */
  InsertAction: defineSlot<InsertAction>({ docLabel: (a) => a.label }),
};

/**
 * Whether a block is a container frame, derived from the `Editor.BlockFrame`
 * registrations themselves. A surface asks "should I group this block's subtree
 * under it?" and gets an answer that cannot disagree with who actually paints a
 * frame — adding or removing a container plugin updates every surface with zero
 * code changes.
 *
 * A predicate over the BLOCK rather than a set of types, because a contribution
 * may declare `applies` — a type that is a container only in some states.
 */
export function useIsFramedBlock(): (block: FrameCandidate) => boolean {
  const contributions = Editor.BlockFrame.useContributions();
  return useMemo(() => {
    const byType = new Map<
      string,
      ((block: FrameCandidate) => boolean) | true
    >();
    for (const c of contributions) {
      if (typeof c.match === "string") byType.set(c.match, c.applies ?? true);
    }
    return (block: FrameCandidate) => {
      const applies = byType.get(block.type);
      return applies === true || (applies !== undefined && applies(block));
    };
  }, [contributions]);
}

/**
 * Block type → the two geometric facts about the box it paints, derived from the
 * same `Editor.BlockFrame` registrations the hook above reads. Third twin on
 * that one source of truth.
 *
 * ONE map rather than two sets, because the second fact is DERIVED from the
 * first plus the decoration seat: computing it at a call site would be the rule
 * spelled twice, and the editable and read-only surfaces both need it.
 */
export function useFrameGeometry(): ReadonlyMap<string, FrameGeometry> {
  const contributions = Editor.BlockFrame.useContributions();
  return useMemo(() => {
    const out = new Map<string, FrameGeometry>();
    for (const c of contributions) {
      if (typeof c.match !== "string") continue;
      const pads = c.pad === "box";
      out.set(c.match, {
        pads,
        // A frame may only absorb a column NOTHING is standing in. A gutter
        // glyph occupies exactly the `BLOCK_INDENT` column absorption would
        // reclaim, so a container that draws one keeps it; a corner name (or no
        // decoration at all) leaves it free. Read off the seat rather than
        // declared again, so a container cannot claim a column it also draws in.
        absorbs: pads && c.anchor === undefined,
      });
    }
    return out;
  }, [contributions]);
}

/**
 * Block type → its container DECORATION and the seat it asked for, derived from
 * the same `Editor.BlockFrame` registrations `useIsFramedBlock()` reads. Twin
 * of that hook, on the same single source of truth: a type has a decoration
 * exactly when the registration that makes it a container also supplies one.
 *
 * A `BlockHandle` declaring `anchor: true` whose plugin supplies no component
 * here is a real disagreement (the reducer would treat the type as a void
 * container while the surface paints nothing) — `./singularity check
 * page-editor:anchor-has-decoration` fails on it.
 */
export function useBlockDecorations(): ReadonlyMap<string, BlockDecoration> {
  const contributions = Editor.BlockFrame.useContributions();
  return useMemo(() => {
    const out = new Map<string, BlockDecoration>();
    for (const c of contributions) {
      if (typeof c.match !== "string") continue;
      // One map, not one hook per seat: a surface that had to ask twice could
      // render one seat and silently drop the other, which is a container whose
      // decoration exists and is nowhere on screen. Asking once makes the seat
      // something the surface must SWITCH on rather than something it can miss.
      if (c.anchor) out.set(c.match, { component: c.anchor, seat: "gutter" });
      else if (c.cornerAnchor)
        out.set(c.match, { component: c.cornerAnchor, seat: "corner" });
    }
    return out;
  }, [contributions]);
}

/**
 * Block type → the sections it contributes to the rail popover, derived from the
 * same `Editor.BlockFrame` registrations the two hooks above read. Twin of
 * `useBlockAnchors()` on the same single source of truth, for the same reason:
 * the menu a container hangs off its borrowed line's rail cannot drift from the
 * registration that makes it a container in the first place.
 *
 * Unlike `anchor` there is no `page-editor:anchor-has-decoration`-style pairing
 * check to owe, and deliberately so: a missing anchor is an INVISIBLE container,
 * while a missing menu is a container with no per-instance appearance — the
 * context card's normal, correct state. The container arm of `BlockActionsMenu`
 * is therefore selected by the CORE fact `BlockHandle.anchor`, never by
 * membership of this map.
 */
export function useBlockFrameMenus(): ReadonlyMap<
  string,
  ComponentType<{ block: Block; api: BlockEditorAPI; close: () => void }>
> {
  const contributions = Editor.BlockFrame.useContributions();
  return useMemo(() => {
    const out = new Map<
      string,
      ComponentType<{ block: Block; api: BlockEditorAPI; close: () => void }>
    >();
    for (const c of contributions) {
      if (typeof c.match === "string" && c.menu) out.set(c.match, c.menu);
    }
    return out;
  }, [contributions]);
}

/**
 * Block type → the FOOT it renders at the bottom of its box, derived from the
 * same `Editor.BlockFrame` registrations `useIsFramedBlock()` /
 * `useFrameGeometry()` / `useBlockDecorations()` / `useBlockFrameMenus()` read.
 * Fourth twin on that one source of truth, for the same reason as the other
 * three: who has a foot cannot drift from who actually paints the box the foot
 * sits inside.
 *
 * Membership is load-bearing beyond dispatch, which is what makes the shared
 * source matter here. A footed frame's own bottom pad moves BELOW its foot
 * (`internal/frame-foot.ts`), so the surface asks this map before it can place a
 * single card's padding — a second registry answering "does this type have a
 * foot" differently from the one that renders it would mis-pad every box on the
 * page, silently.
 *
 * Like `anchor` and `menu`, a foot is UNSEALED: only a field literally named
 * `component` goes through the framework's error-boundary middleware, so a crash
 * inside a foot is not contained to the slot. Documented, not discovered — same
 * as its two neighbours.
 */
export function useBlockFeet(): ReadonlyMap<
  string,
  ComponentType<BlockFootProps>
> {
  const contributions = Editor.BlockFrame.useContributions();
  return useMemo(() => {
    const out = new Map<string, ComponentType<BlockFootProps>>();
    for (const c of contributions) {
      if (typeof c.match === "string" && c.foot) out.set(c.match, c.foot);
    }
    return out;
  }, [contributions]);
}
