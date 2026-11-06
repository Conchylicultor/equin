// The PURE matching engine behind "apply this edited markdown onto that page".
//
// It answers one question — which stored block is which incoming node — and
// turns the answer into the smallest `BlockPatch` that realizes it, plus the
// text changes that must NOT ride that patch. No DB, no React, no I/O.
//
// ---------------------------------------------------------------------------
// The two invariants a survivor's update may never break
// ---------------------------------------------------------------------------
//
//  1. **A survivor's update never names `text`.** A block's text has exactly one
//     owner, its per-block `Y.Doc`; `page_blocks.data.text` is a debounced
//     PROJECTION of it. So a changed text leaves through `textEdits`, and the
//     `data` a survivor's update carries always restates the block's CURRENT
//     projection verbatim — the same thing `preserveText` does when the editor
//     converts a block's type. Writing the incoming text into the row instead
//     would make the row authoritative over the doc for as long as it took the
//     next projection flush to disagree.
//  2. **A survivor's update never names `expanded`.** A parsed forest is
//     uniformly `expanded: true` (a self-closing tag cannot distinguish
//     "collapsed" from "childless", and blocks are born expanded), so writing it
//     would silently unfold every collapsed toggle, callout and sub-page on the
//     page on every apply. Newly created rows carry the incoming node's own
//     `expanded`, which for a parsed forest is that same uniform `true` — except
//     a page this apply mints, which is born folded, as turn-into-page folds one.
//
// Both are properties of the emitted patch, not of a downstream filter, and
// `plan.test.ts` asserts them directly over fuzzed edits.
//
// ---------------------------------------------------------------------------
// Scope: the root bounds every authority the plan claims
// ---------------------------------------------------------------------------
//
// `rootId` is where the walk starts, and it is the ONLY thing bounding what this
// plan may touch. `existing` is deliberately the page's whole `page_id`
// partition (a rank floor, a sub-page pin and a `ref`'s "does this id name a row
// of this page at all" all need rows the walk may not reach), but `oldRows` —
// the walk's output — is what survivors, updates and `deleteIds` are all derived
// from, so a row outside the root's subtree can never be updated, moved or
// deleted however the document was edited.
//
// `redact` narrows the WALK and nothing else, which is why redaction needs no
// second rule anywhere downstream: a pruned row is not a survivor, not an
// update, not a delete — and, because it is still in `existing`, still holds a
// rank nothing may mint over and still answers a `ref` with `ref-out-of-scope`
// rather than `unknown-ref`.
//
// `pageId` is a SECOND, independent fact: which partition created rows join, and
// whether the root is the page itself. It is required rather than inferred
// because a nested root cannot tell you its page — and because the two differing
// is exactly what turns an absent sub-page shell from a re-home into a refusal.
//
// The one created row that joins ANOTHER partition is the body of a page this
// apply mints (`<agent-page title="…">body</agent-page>`): the new page row
// itself joins `pageId`, and everything under it joins the new page. That body
// is asserted new — no stored row can be paired into it — so a row still never
// moves between partitions; see "Minted pages" in the planner.
//
// ---------------------------------------------------------------------------
// Idempotence is the recovery story
// ---------------------------------------------------------------------------
//
// The plan is a pure function of the CURRENT stored state. Re-running an apply
// therefore converges: whatever already landed matches and emits nothing. That
// is what makes the two-channel write (structure atomically, then text per
// block) recoverable rather than corrupt if it fails half-way — and why nothing
// here may depend on having seen the previous attempt.

import {
  PAGE_BLOCK_TYPE,
  carryDisplayOnly,
  coalesce,
  dataEqual,
  markdownParseTagNames,
  markdownTagIsIdentified,
  markdownTagNameOf,
  pageBlockMarkdown,
  runsOf,
  serializeForestToMarkdown,
  withMintedIds,
  type Block,
  type BlockFieldChanges,
  type BlockHandle,
  type BlockPatch,
  type BlockUpdate,
  type IdentifiedBlock,
  type MarkdownContext,
  type RichText,
  type SerializedBlock,
} from "@plugins/page/plugins/editor/core";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import { alignItems, type AlignItem } from "./align";
import {
  documentOrderRows,
  identityKeyOf,
  pinnedRowKey,
  plainTextOf,
  stableJson,
} from "./flatten";
import { maxRank, planSiblingRanks } from "./ranks";
import type { StoredRow } from "./stored-row";

/** One surviving block's new text, to be spliced into its content doc. */
export interface MarkdownTextEdit {
  blockId: string;
  runs: RichText;
}

export interface MarkdownApplyPlan {
  patch: BlockPatch;
  textEdits: MarkdownTextEdit[];
  stats: { survived: number; created: number; deleted: number; moved: number };
}

/**
 * Discriminated, per the repo's absorbable-failure rule: an EMPTY patch means
 * "nothing to do", and must never be confusable with "something went wrong".
 */
export type MarkdownApplyResult =
  | { ok: true; plan: MarkdownApplyPlan }
  | {
      ok: false;
      /**
       * One vocabulary for one mechanism. Every asserted identity — a
       * `<page id="…"/>` pointer, an identified card's `ref` — resolves through
       * the same three questions, so the reasons are named after the CLAIM
       * rather than after the block type that happened to make it.
       * `subpage-removed` keeps its name because it really is page-specific:
       * only a shell owns a whole other partition that an omission must not
       * destroy.
       */
      reason:
        | "unknown-ref"
        | "ref-duplicated"
        | "ref-out-of-scope"
        | "subpage-removed";
      detail: string;
    };

export interface MarkdownApplyArgs<R extends StoredRow = StoredRow> {
  /**
   * The root of the SCOPE. The walk starts at its CHILDREN, so the root row
   * itself is never touched and nothing outside its subtree is ever updated,
   * moved or deleted. The page row for a whole-page apply; any block within the
   * page for a scoped one.
   */
  rootId: string;
  /**
   * The page `existing` was read from — the partition every created row joins.
   * Separate from {@link rootId} rather than inferred from it: a nested root
   * cannot name its own page, and `rootId !== pageId` is what makes an absent
   * sub-page shell a refusal rather than a re-home to the top level.
   */
  pageId: string;
  /** Every LIVE row of the page's own `page_id` partition (sub-page shells included). */
  existing: readonly R[];
  /** The edited document, as `parseMarkdownToForest` produced it. */
  incoming: readonly SerializedBlock[];
  /** The same handle set the parse ran with. */
  handles: readonly BlockHandle<unknown>[];
  /**
   * A row filter applied to {@link existing} BEFORE the walk — the SAME filter
   * the read that produced this document was given, so the plan is a diff
   * against exactly what the author saw. Pruning a row prunes its whole subtree
   * for free (the walk never reaches a child whose parent is gone).
   *
   * **It filters the WALK, and nothing else.** `existing` stays the whole
   * partition: a redacted row still holds a `(parent_id, rank)` key nothing may
   * mint over, and still answers "does this id name a row of this page" for a
   * `ref` the walk cannot reach (which is `ref-out-of-scope` rather than
   * `unknown-ref`). Everything a plan may WRITE — survivors, updates,
   * `deleteIds` — already derives from `oldRows`, so pruning the walk IS the
   * entire mechanism and there is no second filter to keep in sync.
   *
   * The engine never learns what a redaction IS: this is a row filter, and
   * whatever policy chose it lives with the caller. The parameter is mutable and
   * the result is not, so ONE concrete filter (`(rows: StoredBlock[]) =>
   * StoredBlock[]`) satisfies both this and the read's own `redact` option —
   * which is the point, since a read and the apply that answers it must redact
   * identically or the apply diffs against a document nobody saw.
   */
  redact?: (rows: R[]) => readonly R[];
}

/** One incoming node, flattened to document order with its structural parent. */
interface IncomingNode {
  node: IdentifiedBlock;
  /** Index into this array, or null for a top-level node. */
  parentIndex: number | null;
  /**
   * Index of the nearest STRICT ancestor that is a `page` node, or null. Every
   * such ancestor is a page the document MINTS (see "Minted pages" in the
   * planner), so a non-null value means "this node is new content of a new page".
   */
  pageAncestor: number | null;
  type: string;
  data: unknown;
}

function flattenIncoming(forest: readonly IdentifiedBlock[]): IncomingNode[] {
  const out: IncomingNode[] = [];
  const walk = (
    nodes: readonly IdentifiedBlock[],
    parentIndex: number | null,
    pageAncestor: number | null,
  ): void => {
    for (const node of nodes) {
      const index = out.length;
      out.push({
        node,
        parentIndex,
        pageAncestor,
        type: node.type,
        data: node.data ?? {},
      });
      walk(
        node.children,
        index,
        node.type === PAGE_BLOCK_TYPE ? index : pageAncestor,
      );
    }
  };
  walk(forest, null, null);
  return out;
}

/** The runs a stored row currently projects. `[]` for a text-less row. */
function storedRuns(data: unknown): RichText {
  if (data === null || typeof data !== "object") return [];
  return runsOf((data as { text?: unknown }).text);
}

function runsEqual(a: RichText, b: RichText): boolean {
  return stableJson(coalesce(a)) === stableJson(coalesce(b));
}

/**
 * The `data` a survivor's update may carry: everything the incoming node says,
 * plus the stored row's display-only keys (`BlockHandle.displayOnly`),
 * with `text` forced back to the row's CURRENT projection (invariant 1). For a
 * void target type the incoming payload passes through unchanged — including the
 * removal of a `text` key a text→void conversion leaves behind, which that
 * type's strict schema would otherwise reject at the write boundary.
 */
function survivorData(
  stored: unknown,
  parsed: unknown,
  handle: BlockHandle<unknown> | undefined,
  currentRuns: RichText,
): unknown {
  // How the block is SHOWN rides over from the stored row: markdown never
  // carries a display-only key, so the parse cannot mean to clear one.
  const incoming = carryDisplayOnly(handle, stored, parsed);
  if (!handle?.text) return incoming;
  const base =
    incoming !== null &&
    typeof incoming === "object" &&
    !Array.isArray(incoming)
      ? (incoming as Record<string, unknown>)
      : {};
  return { ...base, text: currentRuns };
}

export function planMarkdownApply<R extends StoredRow>(
  args: MarkdownApplyArgs<R>,
): MarkdownApplyResult {
  const { rootId, pageId, existing, incoming, handles, redact } = args;
  const byType = new Map(handles.map((h) => [h.type, h] as const));

  // The only markdown this module emits is a single `<page …/>` POINTER tag,
  // whose attribute values are quoted rather than inline-markdown-escaped — so
  // the inline token spans that `protectedSpans` exists to mask cannot reach it,
  // and an empty list is the honest answer rather than a forgotten parameter.
  // Serialize-only, so `blankLines` is never read; it names the dialect this
  // module's output is in, which is the server's own.
  const ctx: MarkdownContext = {
    handles: [...handles],
    protectedSpans: [],
    blankLines: "empty-block",
    // Must match what the READ emits, or alignment diffs two dialects and every
    // pinned empty paragraph reads as a change nobody made.
    emptyBlocks: "pinned",
    // Must match what the READ emits, for the same reason: a soft break spelled
    // one way here and another there is alignment diffing two dialects.
    softBreaks: "escaped",
  };

  // Everything a plan may WRITE reads `oldRows`, never `existing`: the walk is
  // the scope, and a redaction is a filter on that walk (see `args.redact`).
  const oldRows = documentOrderRows(
    redact ? redact([...existing]) : existing,
    rootId,
  );
  // The two questions only `existing` can answer, both about rows the walk
  // cannot reach: does this id name a row of this page at all (`ref` resolution
  // below), and which `(parent_id, rank)` keys are held by a live row this plan
  // will never write (the rank obstacles further down).
  const existingIds = new Set(existing.map((row) => row.id));
  const reachedIds = new Set(oldRows.map((row) => row.id));

  // --- Asserted identity ----------------------------------------------------
  // Two kinds of node carry a row id rather than earning one from its content: a
  // sub-page shell, whose `<page id="…"/>` or `<agent-page id="…"/>` pointer is
  // its only identity, and a card of an IDENTIFIED type, which round-trips
  // `id="…"` on its own tag so an agent reading the document gets an anchor it
  // can hand back. Both resolve to the same thing — a `pin` (see `align.ts`) —
  // and share one refusal vocabulary, because they are one mechanism.
  //
  // The identified TYPE SET is derived from the handle registry, never named
  // here: this module knows what a tag DECLARES, not which plugin declares it.
  // Naming `agent-note` would be the collection-consumer leak this codebase
  // bans, and would silently stop pinning the day the type is renamed. `page`
  // is in it through its `<agent-page>` spelling, which carries a row id where
  // the `<page>` spelling carries it as its own attribute.
  const identifiedTypes = new Set(
    handles.filter((h) => markdownTagIsIdentified(h)).map((h) => h.type),
  );

  // --- Sub-page identity ----------------------------------------------------
  // A shell's identity is its ROW ID, which `<page id="…"/>` carries and no
  // `data` field does. Resolving the id out of an incoming pointer node without
  // naming a block type is done by SERIALIZING it: the tag is the contract, and
  // the serializer is the only thing that knows how a type encodes its identity
  // into one. A shell row and a pointer at that shell therefore emit the same
  // line, byte for byte, and string equality is the whole test.
  const pageTagName = pageBlockMarkdown.tag?.name ?? PAGE_BLOCK_TYPE;
  const pageRefType =
    handles.find((h) => markdownParseTagNames(h).includes(pageTagName))?.type ??
    null;
  const hasPageHandle = byType.has(PAGE_BLOCK_TYPE);
  const pointerLine = (type: string, data: unknown, id?: string): string =>
    serializeForestToMarkdown(
      [{ id, type, data, expanded: false, children: [] }],
      ctx,
    );
  const shellByLine = new Map<string, StoredRow>();
  if (hasPageHandle) {
    for (const row of oldRows) {
      if (row.type !== PAGE_BLOCK_TYPE) continue;
      shellByLine.set(pointerLine(row.type, row.data, row.id), row);
    }
  }

  // The stored rows whose identity is ASSERTED rather than inferred. An
  // identified card is pinned even when the incoming document never names it —
  // that is what stops a tagless `<agent-inline>` written next to an existing one
  // from absorbing the existing card's row id through an LCS ambiguity (both
  // cards are void and carry the byte-identical content key `agent-note ␀ {}`),
  // which would silently detach that card's authorship. A card the document did
  // not address is simply unmatched, i.e. deleted — see the note on why there is
  // no `note-removed` twin below.
  const pinnedOldRows = new Map<string, StoredRow>();
  const oldItems: AlignItem[] = oldRows.map((row) => {
    const handle = byType.get(row.type);
    const pinned =
      row.type === PAGE_BLOCK_TYPE || identifiedTypes.has(row.type);
    if (pinned) pinnedOldRows.set(row.id, row);
    return {
      key: pinned
        ? pinnedRowKey(row.id)
        : identityKeyOf(row.type, row.data, handle),
      plain: plainTextOf(row.data, handle),
      type: row.type,
      pin: pinned ? row.id : null,
    };
  });
  // The page references this document ALREADY holds. A markdown apply may keep,
  // move or drop one of those; what it may not do is INVENT one, because a pure
  // planner cannot check that an id it has never seen names a real page. This is
  // what keeps a legitimate `page-link` block round-tripping (its key is in here)
  // while a hand-typed `<page id="typo"/>` is refused.
  const existingKeys = new Set(
    oldItems.filter((item) => item.pin === null).map((item) => item.key),
  );

  const identified = withMintedIds([...incoming]);
  const incomingNodes = flattenIncoming(identified);

  // --- Minted pages ----------------------------------------------------------
  // A `page` node the document does NOT pin is a page this apply CREATES: the
  // `<agent-page title="…">body</agent-page>` mint form, the one way a markdown
  // parse produces a page node without a `ref`. Its body joins a partition that
  // does not exist yet, so every node under it answers two questions differently
  // from the rest of the document:
  //
  // - **its `page_id`** is the new page's id, not the apply's (`partitionOf`);
  // - **its identity is asserted NEW.** It is pinned to its own freshly minted id,
  //   so no alignment pass can pair it with a stored row. Without that, a line in
  //   the new body that happens to read like one already on this page would be
  //   paired by pass 3 and MOVED into the new page, keeping the `page_id` of the
  //   page it came from — a row visible in neither.
  //
  // `IncomingNode.pageAncestor` is the nearest STRICT ancestor of a node that is
  // a page node, or null, resolved by the flatten walk. Every such ancestor is a
  // minted page: a pinned pointer carrying a body is refused before anything is
  // planned, so it can never be anyone's ancestor here.

  // The page handle's own spelling choice, for the pointer's canonical check
  // below. A page is written as a different TAG per kind (`<page>` / `<agent-page>`,
  // chosen by its data), so "same tag name" is exactly "same kind of page" — and it
  // compares only the spelling's preset, never the `title` a pointer also carries.
  const pageHandle = byType.get(PAGE_BLOCK_TYPE);
  const pageSpellingOf = (data: unknown): string | null =>
    pageHandle === undefined ? null : markdownTagNameOf(pageHandle, data);

  const newItems: AlignItem[] = [];
  // Every row id this document has already claimed, whatever claimed it. One set
  // for one namespace (see `pinnedRowKey`): a row can occupy one position, so a
  // second claim on it is impossible to honour however it was written.
  const claimedRefs = new Set<string>();
  for (let j = 0; j < incomingNodes.length; j++) {
    const entry = incomingNodes[j]!;
    const handle = byType.get(entry.type);
    const contentKey = identityKeyOf(entry.type, entry.data, handle);
    const isPage = entry.type === PAGE_BLOCK_TYPE;
    const newPage = entry.pageAncestor;
    let pin: string | null = null;

    /**
     * The refusal for an identity claim INSIDE a page this document creates. The
     * claimed row lives in a partition that is not the new page's, and the new
     * body is asserted new by construction — so honouring the claim would move a
     * row between pages, which a markdown apply never does.
     */
    const claimInsideNewPage = (rowId: string): MarkdownApplyResult => ({
      ok: false,
      reason: "ref-out-of-scope",
      detail:
        `The document names row ${rowId} inside the new page it creates. A row ` +
        "cannot move between pages: a new page's body is new content, so write it " +
        "fresh (drop the id), and leave the existing row where it is.",
    });

    // --- An identified node's `ref` ----------------------------------------
    // `ref` is a CLAIM the document's author wrote down — "this node is the row
    // you showed me as `…`" — so it is honoured only after proving the row
    // exists AND is inside this apply's scope. A `ref` on a type that does not
    // round-trip an id is ignored rather than refused: `SerializedBlock.ref` is
    // only ever set by the parse of an identified tag, so one on anything else
    // came from a hand-built forest and means nothing here.
    //
    // Two kinds of node make this claim, and they must not cross: an identified
    // CARD (`<agent-inline id>`, `<human id>`, …) and a page POINTER
    // (`<agent-page id="…"/>`). A card ref pinning a page row would hang the
    // card's children under the page with this page's `page_id`; a pointer
    // pinning a card would turn a card into a page. Either is `unknown-ref`: the
    // id names no addressable row of that kind here.
    const ref = entry.node.ref;
    if (ref !== undefined && identifiedTypes.has(entry.type)) {
      if (newPage !== null) return claimInsideNewPage(ref);
      const target = pinnedOldRows.get(ref);
      if (claimedRefs.has(ref)) {
        return {
          ok: false,
          reason: "ref-duplicated",
          detail:
            `The document claims row ${ref} more than once. One row is one ` +
            "position, so honouring this would require it to be in two places at once.",
        };
      }
      if (target !== undefined && identifiedTypes.has(target.type)) {
        const targetIsPage = target.type === PAGE_BLOCK_TYPE;
        if (targetIsPage !== isPage) {
          return {
            ok: false,
            reason: "unknown-ref",
            detail:
              `The document claims row ${ref} as a ${isPage ? "page" : entry.type}, ` +
              `but it is a ${targetIsPage ? "page" : target.type}. A card's id and a ` +
              "page's id are not interchangeable — re-read the block and copy the tag " +
              "back verbatim.",
          };
        }
        if (isPage) {
          // The POINTER's canonical check: an existing page is named by the tag
          // its own row serializes to, so `<agent-page id="H"/>` naming a HUMAN's
          // page is not a pointer at H — it is a claim that H is something it is
          // not. Only the spelling is compared (it is chosen by the preset keys
          // alone), so a `title` edited on the pointer — or gone stale since the
          // read — is simply ignored, the stance a read-only attribute takes.
          const stored = pageSpellingOf(target.data);
          const claimed = pageSpellingOf(entry.data);
          if (stored !== claimed) {
            return {
              ok: false,
              reason: "unknown-ref",
              detail:
                `The document names page ${ref} as <${claimed ?? PAGE_BLOCK_TYPE}>, but ` +
                `it is written <${stored ?? PAGE_BLOCK_TYPE}>. Which kind of page a page ` +
                "is cannot be changed through markdown — hand its pointer back exactly " +
                "as read_page showed it.",
            };
          }
          if (entry.node.children.length > 0) {
            return {
              ok: false,
              reason: "ref-out-of-scope",
              detail:
                `The document gives existing page ${ref} a body. ${ref}'s content ` +
                `lives in its own page, not in this document: pass ${ref} as the ` +
                "block id to read or write it, and keep its pointer here self-closing.",
            };
          }
        }
        claimedRefs.add(ref);
        pin = ref;
      } else if (existingIds.has(ref) && !reachedIds.has(ref)) {
        // The row is real, and this apply still may not touch it: it is on
        // another branch of the page, or the read this document came from
        // redacted it away. Either way the document is asking to MOVE a row its
        // author never saw into the scope it did see — which is precisely what a
        // page-rooted edit must not be able to do to a redacted card.
        return {
          ok: false,
          reason: "ref-out-of-scope",
          detail:
            `The document claims row ${ref}, which is not inside ${rootId}. A block ` +
            "outside the scope of this apply — on another branch of the page, or " +
            "hidden from the document this edit was written against — cannot be " +
            "moved into it by naming its id.",
        };
      } else {
        // Deliberately NO "already in this document" escape hatch, which is what
        // `<page id="…"/>` gets below. That hatch exists only because the page
        // tag DOUBLES as an ordinary link-to-page block, so an id there is not
        // necessarily an identity claim. An id on an identified tag is *only*
        // ever an identity claim, so a typo must never quietly become a create.
        return {
          ok: false,
          reason: "unknown-ref",
          detail:
            `The document claims row ${ref}, which names no addressable ${entry.type} ` +
            "on this page. An id is only ever an identity claim — drop it to create a " +
            "new one, or re-read the block and copy the id back verbatim.",
        };
      }
    }

    if (pageRefType !== null && entry.type === pageRefType) {
      const shell = shellByLine.get(pointerLine(entry.type, entry.data));
      if (shell !== undefined) {
        if (newPage !== null) return claimInsideNewPage(shell.id);
        if (claimedRefs.has(shell.id)) {
          return {
            ok: false,
            reason: "ref-duplicated",
            detail:
              `The document references sub-page ${shell.id} more than once. ` +
              "A sub-page shell is one row and can occupy one position; honouring " +
              "this would require it to be in two places at once.",
          };
        }
        if (entry.node.children.length > 0) {
          throw new Error(
            `planMarkdownApply: sub-page ${shell.id} was given children. Its content ` +
              "lives in its own page_id partition and cannot be authored through the pointer.",
          );
        }
        claimedRefs.add(shell.id);
        pin = shell.id;
      } else if (!existingKeys.has(contentKey)) {
        return {
          ok: false,
          reason: "unknown-ref",
          detail:
            `The document references a page that is neither a sub-page inside ${rootId} ` +
            "nor a page this document already links to. A markdown apply cannot mint " +
            "a reference to a page it has no way to verify exists.",
        };
      }
    }

    // A page this document creates, and everything under one: asserted NEW (see
    // "Minted pages" above). Its own freshly minted id is the pin, which no old
    // row carries, so the pin pass can never pair it and the content passes skip
    // it — it can only ever be a create.
    if ((isPage && pin === null) || newPage !== null) pin = entry.node.id;

    newItems.push({
      key: pin === null ? contentKey : pinnedRowKey(pin),
      plain: plainTextOf(entry.data, handle),
      type: entry.type,
      pin,
    });
  }

  const pairs = alignItems(oldItems, newItems);
  const usedOld = new Set(pairs.values());

  // --- Identity: survivors keep their row id, the rest are minted ------------
  // Ids ride ON the node (`withMintedIds`), so a created node's children resolve
  // their parent through the same array they were flattened from — a positional
  // id list would silently mis-assign under any traversal change.
  const finalId = incomingNodes.map((entry, j) => {
    const oldIndex = pairs.get(j);
    return oldIndex === undefined ? entry.node.id : oldRows[oldIndex]!.id;
  });
  // A top-level node of the incoming document is a child of the SCOPE's root —
  // the page row for a whole-page apply, the addressed block for a scoped one.
  const parentIdOf = (j: number): string => {
    const parentIndex = incomingNodes[j]!.parentIndex;
    return parentIndex === null ? rootId : finalId[parentIndex]!;
  };
  // The partition node j lands in: the page this document creates around it
  // (the nearest STRICT ancestor page node — a page row is displayed in its
  // parent's partition, never its own), else the apply's own page. `rootId` is a
  // position, not a partition, so it plays no part here.
  const partitionOf = (j: number): string => {
    const newPage = incomingNodes[j]!.pageAncestor;
    return newPage === null ? pageId : finalId[newPage]!;
  };

  // Programming-error guard, not a refusal: a survivor keeps its row, and a row
  // is in exactly one partition, so a survivor can never sit inside a page this
  // document creates. The asserted-new pin above makes pairing one there
  // impossible; this states the consequence loudly rather than letting a broken
  // pin silently move a row between pages with a stale `page_id`.
  for (const [j, oldIndex] of pairs) {
    if (partitionOf(j) !== pageId) {
      throw new Error(
        `planMarkdownApply: stored row ${oldRows[oldIndex]!.id} was paired into the ` +
          `page ${partitionOf(j)} this document creates. A new page's body is asserted ` +
          "new, so no survivor can land there — the pin is broken.",
      );
    }
  }

  // --- Ranks: one sibling list at a time ------------------------------------
  const groups = new Map<string, number[]>();
  for (let j = 0; j < incomingNodes.length; j++) {
    const parent = parentIdOf(j);
    const list = groups.get(parent);
    if (list) list.push(j);
    else groups.set(parent, [j]);
  }

  /**
   * The ranks under `parent` that a live row still holds AFTER this plan lands
   * and that the plan itself never writes — i.e. exactly the rows the WALK could
   * not reach: a redacted card, or a row that does not connect to `rootId`.
   *
   * They are obstacles rather than merely invisible because `Rank.nBetween` is
   * DETERMINISTIC: minting the midpoint of `(rankA, rankB)` reproduces, byte for
   * byte, the key of a hidden row that was itself inserted between A and B — and
   * `page_blocks_parent_rank_live_uq` then fails the whole apply. It fires on the
   * most ordinary edit there is (insert a line between two visible ones), so it
   * is a correctness obstacle, not a tidiness one.
   *
   * A survivor LEAVING this sibling list is deliberately not an obstacle: its own
   * update vacates the key in the same transaction (the forest writer parks ranks
   * unconditionally, so the transient duplicate is already handled), and
   * reserving it would push minted keys around for no safety at all.
   *
   * With no `redact`, every row under an in-scope parent is reachable, so this is
   * empty and rank planning is byte-identical to what it was before redaction
   * existed.
   */
  const reservedByParent = new Map<string, string[]>();
  for (const row of existing) {
    if (row.parentId === null || reachedIds.has(row.id)) continue;
    const list = reservedByParent.get(row.parentId);
    if (list) list.push(row.rank);
    else reservedByParent.set(row.parentId, [row.rank]);
  }
  const reservedRanksUnder = (parent: string): string[] =>
    reservedByParent.get(parent) ?? [];

  const finalRank = new Array<string>(incomingNodes.length);
  for (const [parent, indices] of groups) {
    const ranks = planSiblingRanks(
      indices.map((j) => {
        const oldIndex = pairs.get(j);
        if (oldIndex === undefined) return null;
        const row = oldRows[oldIndex]!;
        // A rank is only meaningful inside one `(parent_id, rank)` space, so a
        // survivor arriving from a different parent has no rank HERE.
        return row.parentId === parent ? row.rank : null;
      }),
      reservedRanksUnder(parent),
    );
    indices.forEach((j, k) => {
      finalRank[j] = ranks[k]!;
    });
  }

  // --- The patch ------------------------------------------------------------
  const updates: BlockUpdate[] = [];
  const textEdits: MarkdownTextEdit[] = [];
  let moved = 0;

  for (let j = 0; j < incomingNodes.length; j++) {
    const oldIndex = pairs.get(j);
    if (oldIndex === undefined) continue;
    const row = oldRows[oldIndex]!;
    const entry = incomingNodes[j]!;
    const changes: BlockFieldChanges = {};

    const parent = parentIdOf(j);
    if (row.parentId !== parent) changes.parentId = parent;
    if (row.rank !== finalRank[j]!) changes.rank = Rank.from(finalRank[j]!);

    // A matched sub-page shell is REPOSITIONED and nothing else. Its incoming
    // counterpart is a pointer block, so honouring `type`/`data` from it would
    // turn a whole page into a link to itself.
    if (row.type !== PAGE_BLOCK_TYPE) {
      const handle = byType.get(entry.type);
      const currentRuns = storedRuns(row.data);
      const nextData = survivorData(row.data, entry.data, handle, currentRuns);
      if (row.type !== entry.type) changes.type = entry.type;
      if (!dataEqual(row.data, nextData)) changes.data = nextData;
      if (handle?.text) {
        const nextRuns = handle.text(entry.data);
        if (!runsEqual(currentRuns, nextRuns)) {
          textEdits.push({ blockId: row.id, runs: coalesce(nextRuns) });
        }
      }
    }

    if (Object.keys(changes).length > 0) {
      updates.push({ id: row.id, changes });
      if (changes.parentId !== undefined || changes.rank !== undefined)
        moved += 1;
    }
  }

  const now = new Date();
  const creates: Block[] = [];
  for (let j = 0; j < incomingNodes.length; j++) {
    if (pairs.has(j)) continue;
    const entry = incomingNodes[j]!;
    const isPage = entry.type === PAGE_BLOCK_TYPE;
    creates.push({
      id: finalId[j]!,
      // The partition, NOT `rootId` (a position in the forest). The apply's own
      // page for everything but a minted page's body, which joins the new page;
      // `applyPageBlockPatch`'s closed-world guard accepts exactly those two.
      pageId: partitionOf(j),
      parentId: parentIdOf(j),
      type: entry.type,
      // A brand-new id has no content doc, so its row IS the seed — the one
      // place `text` legally rides a row write.
      data: entry.data,
      rank: Rank.from(finalRank[j]!),
      // A minted page is born FOLDED, exactly as turn-into-page folds one: a
      // sub-page reads as ONE row in its parent's flow, and its chevron is the
      // way in. Every other created row carries the node's own `expanded`, which
      // for a parsed forest is the uniform `true`.
      expanded: isPage ? false : entry.node.expanded,
      createdAt: now,
      updatedAt: now,
    });
  }

  // --- Sub-pages are never deleted by a markdown apply ----------------------
  // A shell owns an entire other `page_id` partition, so dropping one destroys a
  // page tree. A shell the document did not mention is PRESERVED — kept at the
  // top level, after everything the document did say. Removing a sub-page stays
  // an explicit act, never an inferred one.
  //
  // **An identified card gets NO twin of this, deliberately.** The asymmetry is
  // in what the row OWNS: a shell owns another partition that is not in `rows` at
  // all, so an omission there destroys content the document could not even see,
  // whereas an identified card owns only children that are inside this very
  // scope — every one of them is a line of the document. Omitting a card is
  // therefore an ordinary, fully-informed delete, and preserving it would make
  // "remove this card" unexpressible.
  const preservedShells = oldRows.filter(
    (row, i) => row.type === PAGE_BLOCK_TYPE && !usedOld.has(i),
  );

  // That re-home is only correct when the root IS the page: "the top level" is
  // where a shell the document dropped legitimately belongs. Under a NESTED root
  // the same move would drag a whole page tree INTO the addressed block —
  // inventing a placement the document never asked for, from an omission. So it
  // is a refusal instead. In practice unreachable, because a scoped read emits
  // every shell in scope and a faithfully-edited document still names them,
  // which is exactly why it must be loud rather than quietly tolerated.
  if (rootId !== pageId && preservedShells.length > 0) {
    return {
      ok: false,
      reason: "subpage-removed",
      detail:
        `The document dropped sub-page ${preservedShells.map((s) => s.id).join(", ")} ` +
        `from inside block ${rootId}. A sub-page owns its own page and can never be ` +
        "deleted by a markdown apply; nor can it be lifted out of the block this " +
        "apply is scoped to, which is where preserving it would have to put it. " +
        'Re-read the block and keep every `<page id="…"/>` pointer the document holds.',
    };
  }

  // The floor a preserved shell is re-homed above: everything the document
  // placed at the top level, AND every top-level rank held by a row the walk
  // could not reach. The second half is the same obstacle rule as above, in the
  // one place that does not go through `planSiblingRanks` — `Rank.nBetween(floor,
  // null, n)` below would otherwise be free to mint straight onto a hidden
  // top-level row's key. Same failure, same unique index, and easy to forget
  // precisely because this call site looks like it is minting into open space.
  let floor = maxRank([
    ...(groups.get(rootId) ?? []).map((j) => finalRank[j]!),
    ...reservedRanksUnder(rootId),
  ]);
  const appended: StoredRow[] = [];
  for (const shell of preservedShells) {
    const rank = Rank.from(shell.rank);
    // Already sitting after everything the document placed: leave it exactly
    // where it is, and let it bound whatever is appended behind it. A shell
    // ANYWHERE else moves — its own sibling list was re-ranked without it, so
    // the only interval provably free of a collision is above the floor.
    if (
      shell.parentId === rootId &&
      (floor === null || Rank.compare(rank, floor) > 0)
    ) {
      floor = rank;
      continue;
    }
    appended.push(shell);
  }
  if (appended.length > 0) {
    const ranks = Rank.nBetween(floor, null, appended.length);
    appended.forEach((shell, k) => {
      const changes: BlockFieldChanges = { rank: ranks[k]! };
      if (shell.parentId !== rootId) changes.parentId = rootId;
      updates.push({ id: shell.id, changes });
      moved += 1;
    });
  }

  // Delete authority is bounded by the WALK, never by `existing`: `oldRows` is
  // the subtree rooted at `rootId`, so a row the walk did not reach is not a
  // candidate here no matter what the incoming document says. That one line is
  // the whole of what root-scoping buys — there is no second filter to keep in
  // sync with it.
  const deleteIds = oldRows
    .filter((row, i) => !usedOld.has(i) && row.type !== PAGE_BLOCK_TYPE)
    .map((row) => row.id);

  return {
    ok: true,
    plan: {
      patch: { creates, updates, deleteIds },
      textEdits,
      stats: {
        survived: pairs.size + preservedShells.length,
        created: creates.length,
        deleted: deleteIds.length,
        moved,
      },
    },
  };
}
