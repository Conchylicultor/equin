import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import {
  applyPageBlockPatch,
  PAGE_BLOCK_TYPE,
  serializePageContent,
  type StoredBlock,
} from "@plugins/page/plugins/editor/server";
import { parseMarkdownToForest } from "@plugins/page/plugins/editor/core";
import { writeBlockTexts } from "@plugins/page/plugins/block-text-write/server";
import {
  documentOrderRows,
  dropInertNodes,
  dropInertRows,
  pageTitleBanner,
  planMarkdownApply,
  planWriteCount,
  splitPageMeta,
  stripPageTitleBanner,
  subtractNoise,
  type InertBlocks,
  type MarkdownApplyPlan,
} from "../../core";
// Not through the core barrel: the wording has exactly one caller, and this
// plugin's public API is the engine, not the sentence it refuses with.
import { roundTripCreatesRefusal } from "../../core/refusal";
import { serverMarkdownContext } from "./markdown-context";
import { loadBlockScope, type BlockScopePageRow } from "./read";

/**
 * Apply an edited markdown document onto an existing block's subtree — the write
 * half of read → edit → write.
 *
 * ---------------------------------------------------------------------------
 * The root is the scope; the page is the transaction
 * ---------------------------------------------------------------------------
 *
 * The plan is bounded by its ROOT (see `core/plan.ts`), so a scoped apply can
 * only rewrite the addressed block's subtree. The WRITE is still a whole-page
 * one: `applyPageBlockPatch` locks the page's entire forest either way, because
 * `(parent_id, rank)` is one ordering space and a partial lock would not make a
 * partial write safe. Narrowing the lock to the subtree would buy concurrency
 * this has no need for and lose the atomicity it depends on.
 *
 * ---------------------------------------------------------------------------
 * Two channels, in this order, because they have two owners
 * ---------------------------------------------------------------------------
 *
 *  1. **Structure** — one `applyPageBlockPatch`, i.e. one locked transaction
 *     over the page's forest (which also fires `notifyStructuralChange`). It is
 *     atomic, and it is THE sanctioned forest write; there is no second route
 *     into `page_blocks`.
 *  2. **Text** — the plan's `textEdits`, AFTER that commit, through
 *     `writeBlockTexts` (`page/block-text-write`): every doc first, then the
 *     rows' `data.text` projection as one patch. After, not before:
 *     `page_block_docs.block_id` is an FK onto `page_blocks.id`, so a created
 *     block has no row to hang a doc off until the patch lands. The ordering
 *     inside the text step, and why the projection is not optional, are that
 *     plugin's to state — see its CLAUDE.md.
 *
 * ---------------------------------------------------------------------------
 * Failure: idempotence IS the recovery story
 * ---------------------------------------------------------------------------
 *
 * Step 1 is atomic. Step 2 is per-block and throws loudly naming the block,
 * which can leave structure applied and only some text written. That is
 * recoverable rather than corrupt because **the plan is a pure function of the
 * CURRENT stored state**: re-running the same apply converges — a block whose
 * text already landed matches on the way in and emits nothing, and
 * `writeBlockTexts` leaves a doc and a row that already read as the target
 * runs alone.
 *
 * So there is deliberately no retry loop and no compensating rollback here.
 * Adding one would replace a loud, convergent partial state with a silent
 * attempt to guess which half of a two-owner write to undo.
 *
 * ---------------------------------------------------------------------------
 * The plan is the caller's EDIT, not the round trip's
 * ---------------------------------------------------------------------------
 *
 * A caller edits by splicing a string into the document a read handed it, so
 * every OTHER block on the page round-trips through markdown → forest untouched
 * — and wherever that projection is lossy, the loss arrives here as a write the
 * caller never asked for. Given the document the caller started from
 * ({@link ApplyBlockOptions.baseline}), this plans that document against the
 * SAME rows and subtracts it: what both plans write identically is round-trip
 * loss, and what is left is the edit. See `core/subtract-noise.ts`.
 *
 * The subtraction happens BEFORE `assertAcceptable`, because a policy must judge
 * what will actually be written; and the report is built off the SUBTRACTED
 * plan, because a caller reading it is asking what its edit did.
 *
 * ---------------------------------------------------------------------------
 * Provenance: agent-origin does NOT apply, on purpose
 * ---------------------------------------------------------------------------
 *
 * `agentOriginCreateHook` reads the the origin header header off an HTTP
 * `Request` and marks whole PAGES an automated session created, for a 24h
 * retention sweep of e2e debris. A markdown apply has no `Request` (it runs from
 * an MCP tool), and the one page it can create — an agent-authored page minted
 * by `<agent-page title="…">` — is written through `applyPageBlockPatch`, which
 * never fires `BlockLifecycle.AfterCreate`. So the sweep never sees it, and must
 * not: an agent-authored page is a real document the user keeps. Do not "fix"
 * this by synthesizing a header or firing the hook: it would hand the page to
 * the sweep. (The two share a word and nothing else — see
 * `research/2026-09-11-page-agent-pages.md`.)
 */

export interface ApplyBlockOptions {
  /**
   * The row filter that produced the document being applied — the SAME function
   * the read was given (`ReadBlockOptions.redact`), which is why both options
   * take the same shape: a caller passes ONE function to both halves, and a read
   * and the apply that answers it cannot drift into diffing against a document
   * nobody ever saw.
   *
   * It prunes the planner's WALK only. The whole partition is still loaded and
   * still handed to the planner, so a hidden row keeps its `(parent_id, rank)`
   * key reserved and stays distinguishable from an id that names nothing —
   * see `core/plan.ts`'s `redact`.
   */
  redact?: (rows: StoredBlock[]) => readonly StoredBlock[];
  /**
   * The document the caller's edit was made AGAINST — what the read returned,
   * before the caller spliced anything into it.
   *
   * A caller edits one string inside a whole document and hands the whole
   * document back, so every block it did not touch still round-trips through
   * markdown → forest. Writes this baseline would ALSO produce are that round
   * trip's, not the caller's, and are subtracted from the plan before it is
   * judged and before it is written (`core/subtract-noise.ts`). What is left is
   * the edit, which is what `assertAcceptable` sees and what the report counts.
   *
   * It is planned against the SAME rows, the same `redact` and the same markdown
   * dialect as the edited document — planning it from a second read would diff
   * two different forests. Omit it when the caller composed its document rather
   * than editing one this engine produced: there is then no round trip to
   * subtract, and a wrong baseline would cancel real writes.
   */
  baseline?: string;
  /**
   * Judge the plan BEFORE a row is written. **Throwing refuses the whole apply**,
   * and is the only way to refuse one: there is no return value, because a
   * boolean would need this module to invent the wording and the status of a
   * refusal it cannot describe.
   *
   * The engine's second caller-supplied predicate, and the exact DUAL of
   * {@link redact}: `redact` decides what a write may SEE, this decides what it
   * may DO. Both keep the engine audience-agnostic — one takes rows and returns
   * rows, the other takes a plan and either returns or throws, and neither
   * teaches this plugin what a policy is. `core/touched.ts` is the vocabulary a
   * caller normally judges with (`touchedBlocks`, `boundaryViolations`), and it
   * names no block type either.
   *
   * Called **exactly once, synchronously**, after planning — and after the
   * {@link baseline} subtraction, so the plan it judges is the one that will
   * actually be written — and strictly before the first
   * `applyPageBlockPatch`, so a refusal has provably written nothing,
   * exactly like the planner's own refusals above it. `rows` is the same
   * whole-partition, UNREDACTED row set the plan was built over, which is what a
   * chain walk needs: an ancestor may be a row the document never showed.
   * `pageRow` is the page's own row from that same read — above every row of the
   * partition, and the last thing such a walk can ask (see
   * `BlockScope.pageRow`).
   *
   * There is deliberately no exported `plan`/`commit` pair doing the same job
   * from outside. A caller holding a plan could commit it against rows it re-read
   * — a different forest from the one the plan diffs — and no type can express
   * "these two came from the same read". Keeping the hook inside the one function
   * that owns both halves makes that unreachable rather than merely discouraged.
   */
  assertAcceptable?(
    plan: MarkdownApplyPlan,
    forest: { rows: readonly StoredBlock[]; pageRow: BlockScopePageRow },
  ): void;
  /**
   * The content-free blocks this caller's document has NO SAY over — left
   * exactly as stored rather than written or refused (see `core/inert.ts`).
   *
   * The third answer beside {@link redact} and {@link assertAcceptable}: `redact`
   * hides what a write may not SEE, `assertAcceptable` refuses what it may not
   * DO, and this declines writes that are not worth refusing — an empty
   * paragraph added or left out where the caller may not write. Inert rows are
   * pruned from the walk (after `redact`, so they keep their rank as an
   * obstacle), inert nodes are dropped from the parsed document, and neither
   * can be created, moved or deleted.
   *
   * Asked ONCE per apply, with the same unredacted rows `assertAcceptable` gets
   * plus the scope root, because whether a block is inert usually depends on
   * what it sits inside — which may be above the root. Applied identically to
   * the edited document and to the {@link baseline}, so the two still plan the
   * same dialect.
   */
  inert?(forest: {
    rows: readonly StoredBlock[];
    pageRow: BlockScopePageRow;
    rootId: string;
  }): InertBlocks;
}

export interface ApplyReport {
  /** The block this apply was rooted at — the page row for a whole-page apply. */
  rootId: string;
  /** The page whose forest was locked and written. */
  pageId: string;
  stats: { survived: number; created: number; deleted: number; moved: number };
  /**
   * Block ids that kept their identity (and therefore their doc, star, links…).
   * Scoped to the root's subtree, like every other authority in this apply: a
   * row outside it was never a candidate for anything, and reporting it as a
   * "survivor" would claim the apply had considered it.
   */
  survivingIds: string[];
  createdIds: string[];
  /**
   * The PAGES among {@link createdIds} — each a new `<agent-page>` the document
   * minted, whose body is the rest of `createdIds` under it. Separate because a
   * caller has to tell the page from its content: the page's id is what it passes
   * back to read or write the page, and a body row's is not.
   */
  createdPageIds: string[];
  /** Survivors whose content doc this apply spliced. */
  textEditedIds: string[];
  /**
   * Writes the read → edit → write round trip produced by itself, subtracted
   * from this plan before it was judged and written (see
   * {@link ApplyBlockOptions.baseline}). `0` when no baseline was given.
   *
   * Reported rather than merely dropped: a subtraction that quietly removed
   * writes would be indistinguishable from a plan that never made them, and the
   * number is how anyone notices the projection has become lossier.
   */
  absorbedWrites: number;
  /**
   * The inert blocks this apply left alone (see {@link ApplyBlockOptions.inert}):
   * how many stood in the scope, and how many the edited document held. Equal
   * when the caller echoed them; a surplus of `incoming` is inert lines it added
   * and nothing wrote, a surplus of `stored` is ones it left out and nothing
   * deleted. `{ stored: 0, incoming: 0 }` when no `inert` was given.
   */
  inert: { stored: number; incoming: number };
}

/** One scoped apply: the two channels, over rows a caller has already read. */
async function applyToScope(scope: {
  rootId: string;
  pageId: string;
  /** The page's STORED title — the banner this apply may have to strip. */
  title: string;
  /** The page's own row, from the same read as `rows` — for `assertAcceptable`. */
  pageRow: BlockScopePageRow;
  rows: readonly StoredBlock[];
  markdown: string;
  baseline?: string;
  redact?: ApplyBlockOptions["redact"];
  assertAcceptable?: ApplyBlockOptions["assertAcceptable"];
  inert?: ApplyBlockOptions["inert"];
}): Promise<ApplyReport> {
  const {
    rootId,
    pageId,
    title,
    pageRow,
    rows,
    markdown,
    baseline,
    redact,
    assertAcceptable,
    inert,
  } = scope;
  const ctx = serverMarkdownContext();
  // Asked once: both documents below are planned against the same answer.
  const inertBlocks = inert?.({ rows, pageRow, rootId });
  // What the walk may reach: the caller's redaction, then the inert rows. Composed
  // in that order so an inert row the redaction already hid is simply absent,
  // and everything pruned — by either — keeps its rank as an obstacle.
  const walkFilter =
    inertBlocks === undefined
      ? redact
      : (all: StoredBlock[]): readonly StoredBlock[] =>
          dropInertRows(redact ? redact(all) : all, inertBlocks.row);
  // Everything a document has to go through to become a plan, in ONE place: the
  // edited document and the baseline are planned by the same call, against the
  // same rows, with the same context and the same redaction. Two spellings of
  // this would diff two dialects, and the subtraction below would then cancel
  // nothing while looking like it worked.
  const planOf = (md: string) => {
    // The banner comes off BEFORE the parse and only for a page ROOT — the exact
    // mirror of where `readBlockAsMarkdown` puts it on, so what a read emitted is
    // what an apply takes back. Built from the STORED title, never from anything
    // in the incoming document: the test is "is this line still the one this
    // page's own read produced", and a document cannot answer that about itself.
    // Anything that fails the test falls through to the planner and is judged
    // there — see `core/page-title.ts` for the four arms and why they are right.
    // The `<page-meta>` header comes off first — a read puts it on outside the
    // banner — and by STRUCTURE, its values ignored: they are read-only facts
    // held elsewhere (`core/page-meta.ts`). A header holding a line it does not
    // know is refused rather than skipped, so nothing written inside it is lost.
    const split = splitPageMeta(md);
    if (!split.ok) {
      throw new HttpError(
        400,
        `markdown apply refused for block ${rootId} on page ${pageId}: ${split.reason}`,
      );
    }
    const document =
      rootId === pageId
        ? stripPageTitleBanner(split.rest, pageTitleBanner(title, ctx))
        : split.rest;
    const parsed = parseMarkdownToForest(document, ctx);
    const { forest, dropped } =
      inertBlocks === undefined
        ? { forest: parsed, dropped: 0 }
        : dropInertNodes(parsed, inertBlocks.node);
    return {
      dropped,
      result: planMarkdownApply({
        rootId,
        pageId,
        // The WHOLE partition, redacted or not: the filter prunes the planner's
        // walk, which is the entire mechanism — see `core/plan.ts`.
        existing: rows,
        incoming: forest,
        handles: ctx.handles,
        redact: walkFilter,
      }),
    };
  };

  const edited = planOf(markdown);
  const result = edited.result;
  const inertIncoming = edited.dropped;
  // A refusal returns BEFORE any write: the planner cannot verify what it was
  // asked to do, and half-applying it would be worse than refusing it.
  if (!result.ok) {
    throw new HttpError(
      409,
      `markdown apply refused for block ${rootId} on page ${pageId} ` +
        `(${result.reason}): ${result.detail}`,
    );
  }

  // --- The round trip's own writes come back out --------------------------
  // Before the policy judges and before anything is written, so what is judged
  // is what will be written. The baseline is the document the caller edited, so
  // whatever planning it writes is loss in the markdown projection rather than
  // anything the caller asked for — see `core/subtract-noise.ts`.
  let plan = result.plan;
  let absorbedWrites = 0;
  if (baseline !== undefined) {
    const identity = planOf(baseline).result;
    if (!identity.ok) {
      // The document a read produced cannot be applied back onto the rows it was
      // read from. Nothing the caller did can cause this, so it is a bug in the
      // read or the planner, and it must be loud rather than degrade into an
      // unsubtracted apply that then refuses the caller for the engine's fault.
      throw new Error(
        `markdown apply: the baseline document for block ${rootId} on page ${pageId} ` +
          `does not plan against its own rows (${identity.reason}): ${identity.detail}`,
      );
    }
    // The second condition of the same guard, and the reachable one. A baseline
    // that plans CREATES means the READ invented blocks: the markdown projection
    // fanned one stored block out into several document lines, and handing that
    // document straight back mints the extra ones. (Found through a soft line
    // break, which had no markdown spelling of its own — see
    // `research/2026-09-10-page-soft-break-markdown-round-trip.md`.)
    //
    // **This is `subtractNoise`'s precondition, enforced instead of assumed.**
    // That module's header states it as a fact — a create in the noise plan
    // would be a projection bug rather than something to absorb — and it cannot
    // check it for itself: it is a pure function over two plans and has no rows,
    // no root and no page to name. So the check lives here, at the one caller
    // that holds all three.
    //
    // **Creates, and only creates.** `updates`, `deleteIds` and `textEdits` all
    // key off EXISTING row ids, so the subtraction cancels them and the row
    // survives untouched — that is the designed, working behaviour (a paragraph
    // whose text is a single space is absorbed exactly this way), and making them
    // fatal would refuse edits that work today. A create has no id to key on:
    // every planning pass mints a fresh `crypto.randomUUID()`, so two passes'
    // creates are not comparable and there is nothing to subtract. It is the one
    // channel where round-trip damage cannot be told apart from the caller's own
    // work, which is exactly why it has to stop the apply rather than be judged:
    // the alternative is what this already cost once — a caller refused over
    // blocks the read invented, inside a card it had never gone near.
    //
    // **Not "drop the phantom creates".** With no id to match on, the only
    // handles are content and position, and an edit near the lossy block changes
    // both — so the match is guesswork, and a wrong one either deletes the
    // author's text or lets a phantom block through. It would also hide the
    // projection bug for good: every edit would appear to succeed while the
    // page's markdown stayed a lie.
    //
    // `HttpError(409)`, deliberately unlike the plain `Error` immediately above:
    // that guard is unreachable from any input, so a 500 is right for it, where
    // this one is reachable from ordinary stored text and the agent that hits it
    // is the only party who can relay the message — it has to be able to read
    // what it is relaying. 409 is also what the planner's own refusal a few lines
    // up and `agent-access`'s corrupt-forest refusal say: *this cannot be
    // applied*, not *you did something wrong*.
    if (identity.plan.patch.creates.length > 0) {
      throw new HttpError(
        409,
        roundTripCreatesRefusal({
          rootId,
          pageId,
          rows,
          identity: identity.plan,
        }),
      );
    }
    // Safe to subtract now, and only now: the guard above is what makes the
    // "creates are never subtracted, and cannot be" clause of
    // `core/subtract-noise.ts` true of this plan rather than merely assumed of
    // it.
    const subtracted = subtractNoise(plan, identity.plan);
    absorbedWrites = planWriteCount(plan) - planWriteCount(subtracted);
    plan = subtracted;
  }

  // The caller's own verdict on the plan, between "what would this write" and
  // "write it". It is handed the UNREDACTED rows the plan was built over, since
  // a policy reasoning about ancestry needs rows the document never showed.
  // Throwing here refuses the whole apply with nothing written — the same
  // guarantee the planner's refusal above has, and the reason this cannot be a
  // check the caller performs afterwards.
  assertAcceptable?.(plan, { rows, pageRow });

  const { patch, textEdits, stats } = plan;

  // --- 1. Structure, atomically --------------------------------------------
  const { blocks } = await applyPageBlockPatch(pageId, patch);

  // --- 2. Text: every doc, then the row projections as one patch -----------
  await writeBlockTexts(pageId, textEdits);

  const createdIds = patch.creates.map((b) => b.id);
  const createdSet = new Set(createdIds);
  const createdPageIds = patch.creates
    .filter((b) => b.type === PAGE_BLOCK_TYPE)
    .map((b) => b.id);
  // The SAME walk the plan was built over, re-run on the post-patch rows — so
  // "survived" means "still in the scope this apply had authority over", and a
  // preserved sub-page shell re-homed above the rank floor is counted where it
  // now sits rather than where it used to. `Block.rank` is a `Rank` value object
  // where the engine reads the RAW stored string, which is the one projection
  // `serializePageContent` also makes on the way in.
  const inScope = documentOrderRows(
    blocks.map((b) => ({
      id: b.id,
      parentId: b.parentId,
      type: b.type,
      data: b.data,
      rank: b.rank.toJSON(),
      expanded: b.expanded,
    })),
    rootId,
  );
  return {
    rootId,
    pageId,
    stats,
    survivingIds: inScope.filter((b) => !createdSet.has(b.id)).map((b) => b.id),
    createdIds,
    createdPageIds,
    textEditedIds: textEdits.map((e) => e.blockId),
    absorbedWrites,
    inert: {
      stored:
        inertBlocks === undefined
          ? 0
          : documentOrderRows(redact ? redact([...rows]) : rows, rootId).filter(
              (row) => inertBlocks.row(row),
            ).length,
      incoming: inertIncoming,
    },
  };
}

/**
 * Apply an edited markdown document onto one block's subtree. Nothing outside
 * that subtree — and not the block itself — can be written, whatever the
 * document says.
 */
export async function applyMarkdownToBlock(
  blockId: string,
  markdown: string,
  opts?: ApplyBlockOptions,
): Promise<ApplyReport> {
  const { pageId, title, pageRow, rows } = await loadBlockScope(blockId);
  return applyToScope({
    rootId: blockId,
    pageId,
    title,
    pageRow,
    rows,
    markdown,
    baseline: opts?.baseline,
    redact: opts?.redact,
    assertAcceptable: opts?.assertAcceptable,
    inert: opts?.inert,
  });
}

/**
 * Apply an edited markdown document onto a whole page — {@link
 * applyMarkdownToBlock} rooted at the page row.
 *
 * Its own entry point for the same reason `readPageAsMarkdown` is: the snapshot
 * coming back IS the proof that `pageId` names a live PAGE row, so a caller that
 * means "this page" cannot silently rewrite the page around a content block.
 */
export async function applyMarkdownToPage(
  pageId: string,
  markdown: string,
  opts?: ApplyBlockOptions,
): Promise<ApplyReport> {
  const snapshot = await serializePageContent(pageId);
  if (!snapshot) {
    throw new HttpError(404, `page ${pageId} does not exist`);
  }
  return applyToScope({
    rootId: pageId,
    pageId,
    title: snapshot.page.title,
    pageRow: { id: pageId, type: PAGE_BLOCK_TYPE, data: snapshot.page },
    rows: snapshot.blocks,
    markdown,
    baseline: opts?.baseline,
    redact: opts?.redact,
    assertAcceptable: opts?.assertAcceptable,
    inert: opts?.inert,
  });
}
