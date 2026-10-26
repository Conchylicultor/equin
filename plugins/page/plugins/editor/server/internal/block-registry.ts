import type { Klass, LexicalNode } from "lexical";
import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";
import {
  tokenExtension,
  type InlineTokenExtension,
  type InlineTokenNodeRef,
} from "@plugins/primitives/plugins/text-editor/plugins/token-extension/core";
import type { AgentCodeSpan, BlockHandle, MarkdownSpan } from "../../core";

// Server-reachable `type → handle` registry. `Editor.Block` is a WEB-only dispatch
// slot, so nothing on the server could resolve a block type's `data` schema; each
// block-type plugin contributes its handle here so the write boundary can validate.
//
// No eager self-registering index (unlike `fields`'s `Fields.Storage`): that mirror
// exists only because `resolveFieldStorage` runs at module-eval inside `defineEntity`,
// BEFORE `collectContributions`. Block validation runs at REQUEST time, long after the
// boot-time collect pass has populated the live registry — so the plain token suffices.
// Do not "restore" an eager map.
export const Editor = {
  /** Per-type `data` schema. Contribute the block handle; keyed by `type`. */
  BlockData: defineServerContribution<BlockHandle<unknown>>("page.block-data", {
    docLabel: (h) => h.type,
  }),

  /**
   * One inline decorator token family — the server twin of the web-only
   * `registerBlockTextExtension`.
   *
   * **`pattern`** is the LOCATOR: how to find one of this family's tokens in a
   * line, so it can be built, serialized and re-materialized. **`node`** is the
   * spec object from the family's own `core/` — the very object the browser's
   * class extends via `.decorated({…})`, never a class of its own. Because it is
   * one object rather than two literals that agree today, the two runtimes
   * cannot name a different type string, different field names or a different
   * token format: that is the argument the pattern half already made, extended
   * to the node half. Which is also why there is no parity check here.
   *
   * **`markdownSpan`** is a SEPARATE question from `pattern`, and required for
   * exactly that reason: it says whether those bytes must be masked from the
   * marks-aware inline scan (see {@link MarkdownSpan}, which states the whole
   * argument). One regex can answer both questions, so the two used to be one
   * field — and every registered token therefore got masking whether it needed
   * it or not, which silently strips the marks a person put on the span. A bare
   * id inside backticks came back as an unmarked run, so documentation turned
   * into a live widget. Keep them apart.
   *
   * `node` is OPTIONAL: a pure text token with no decorator is legitimate, and
   * every contribution was pattern-only before the node half existed. A family
   * that contributes none keeps being refused by
   * `block-text-write`'s `readStateRuns` — the refusal narrows to the types that
   * still have no server node, it does not soften.
   *
   * `pattern` is REQUIRED even alongside a `node`, and that is the shape rather
   * than an accident of history: without it `blockTextServerExtensions` can mint
   * no extension for the family, so `tokenOf` would fall through to the node's
   * own `getTextContent()` — `""` for every `textContent: "empty"` family — and
   * silently delete the token it just hydrated. The lossy shape is unspellable.
   */
  InlineToken: defineServerContribution<{
    pattern: RegExp;
    markdownSpan: MarkdownSpan;
    /**
     * What `` `<token>` `` means in text an agent writes to a page — the
     * token itself (a bare id) or code (a token with a syntax). A third
     * question, again separate from both above: see {@link AgentCodeSpan}.
     */
    agentCodeSpan: AgentCodeSpan;
    node?: InlineTokenNodeRef;
  }>("page.inline-token", {
    docLabel: (t) => t.pattern.source,
  }),

  /**
   * A supplier of `markdown.tag.annotated` attribute values — the facts a block
   * tag carries that do NOT live in the block's `data` (a TODO card's linked
   * task id and that task's status live in another table keyed by block id).
   *
   * `resolve` is handed the rows a markdown read is about to walk and answers
   * with a block id → attribute record map, holding only the blocks it has
   * something to say about. A provider that recognizes none of the rows answers
   * with an empty map and does no work; the whole registry being empty means the
   * read pays nothing at all.
   *
   * It takes the rows in one call rather than one call per block on purpose: a
   * provider's natural query is a single `WHERE parent_id IN (…)`, bounded by
   * the page, and a per-block seam would turn a page read into N round trips.
   *
   * Each row carries its `data`, because the read already holds full rows and
   * some answers are IN them: a human sub-page's `title` is its own row's, and
   * a link-to-page block's `pageId` is what its provider looks the target up
   * by. A provider must not read it back from the table instead.
   */
  BlockAnnotation: defineServerContribution<{
    resolve(
      rows: readonly { id: string; type: string; data: unknown }[],
    ): Promise<ReadonlyMap<string, Record<string, string>>>;
  }>("page.block-annotation"),
};

/**
 * Resolve the block handle for a `type`, or `undefined` if no plugin contributed one.
 * Two plugins claiming one `type` is a defect (last-write-wins would silently mask a
 * schema collision), so a duplicate registration throws loudly, naming the offenders.
 */
export function resolveBlockHandle(
  type: string,
): BlockHandle<unknown> | undefined {
  const matches = Editor.BlockData.getContributions().filter(
    (h) => h.type === type,
  );
  if (matches.length > 1) {
    const owners = matches.map((h) => h._pluginId ?? "<unknown>").join(", ");
    throw new Error(
      `Duplicate Editor.BlockData registration for block type "${type}" from: ${owners}. ` +
        `A block type's data schema must be owned by exactly one plugin.`,
    );
  }
  return matches[0];
}

/**
 * The patterns of the families that ASKED to be masked, as the
 * `MarkdownContext.protectedSpans` the markdown conversion requires — the server
 * twin of the web's `blockTextProtectedSpans()`. An inline decorator token
 * (`[[page:…]]`, `[[date:…]]`, `\(latex\)`) is a plain substring inside
 * `TextRun.text` whose bytes markdown would read as syntax, so the marks-aware
 * inline scan must be told to leave them alone; inline LaTeX is full of `_` and
 * `*`. Without it, server-side serialization corrupts every token it walks over.
 *
 * Only `markdownSpan: "protect"` families are here — a bare-id token is
 * markdown-inert, and masking it would cost the span its marks for nothing.
 * That filter is the point of the field; see {@link MarkdownSpan}.
 *
 * Read at call time, never memoized: mirrors the web accessor, and a snapshot
 * taken before `collectContributions` would silently degrade to no protection.
 *
 * The patterns are shared module constants and some of them DO carry `g` (every
 * `inlineBoundary` one does), which would make `lastIndex` a cross-call side
 * channel if anything scanned with the object itself. Nothing does:
 * `maskProtected` (`core/inline-markdown.ts`, the sole consumer of this list)
 * and `matchTokens` (the sole consumer of the same pattern inside a token
 * extension) both re-create the regex from `.source` before scanning. Keep it
 * that way rather than requiring flagless patterns — a contributor cannot
 * control the flags of a shape it composes from somewhere else.
 */
export function blockTextProtectedSpans(): RegExp[] {
  return Editor.InlineToken.getContributions()
    .filter((t) => t.markdownSpan === "protect")
    .map((t) => t.pattern);
}

/**
 * The patterns of the families whose backticked token, in text an agent
 * writes, is the token itself (`agentCodeSpan: "token"` — the bare ids), for
 * `unwrapAgentCodeSpans`. Read at call time, for
 * {@link blockTextProtectedSpans}' reason.
 */
export function agentCodeSpanTokens(): RegExp[] {
  return Editor.InlineToken.getContributions()
    .filter((t) => t.agentCodeSpan === "token")
    .map((t) => t.pattern);
}

/**
 * The contributed token families that carry a NODE, resolved once and checked
 * for a type collision.
 *
 * Two contributions may share a node `type` — that is exactly how active-data's
 * four inline-chip sub-plugins each contribute their own pattern against ONE
 * shared `inlineChipNode` — but only when they name the SAME spec object.
 * Two different objects claiming one type is a defect and throws, naming both
 * owners: Lexical keys its node registry by type string and rejects the second
 * class, so the two could never both be registered, and whichever won would be
 * deciding another plugin's field names and token format.
 *
 * Read at call time, never memoized, for {@link blockTextProtectedSpans}'
 * reason: a snapshot taken before `collectContributions` reports no nodes at
 * all, which reads exactly like a family that never contributed one.
 */
function nodeContributions(): {
  id: string;
  pattern: RegExp;
  node: InlineTokenNodeRef;
}[] {
  const out: { id: string; pattern: RegExp; node: InlineTokenNodeRef }[] = [];
  const claimedBy = new Map<
    string,
    { node: InlineTokenNodeRef; owner: string }
  >();
  for (const contribution of Editor.InlineToken.getContributions()) {
    const node = contribution.node;
    if (!node) continue;
    const owner = contribution._pluginId ?? "<unknown>";
    const previous = claimedBy.get(node.type);
    if (previous && previous.node !== node) {
      throw new Error(
        `Two Editor.InlineToken contributions declare the inline node type ` +
          `"${node.type}" with DIFFERENT spec objects: ${previous.owner} and ${owner}. ` +
          "Several patterns may feed ONE node (that is how a union of tokens works), " +
          "but they must name the same object from the declaring plugin's `core/` — " +
          "Lexical registers one class per type string, so two would silently " +
          "disagree about that type's fields and token format.",
      );
    }
    if (!previous) claimedBy.set(node.type, { node, owner });
    out.push({
      id: `${owner}:${node.type}`,
      pattern: contribution.pattern,
      node,
    });
  }
  return out;
}

/**
 * Every contributed token family that has a server node, as the
 * {@link InlineTokenExtension} the shared runs↔nodes walks take — the server
 * twin of the web's `blockTextTokenExtensions()`.
 *
 * With these, a headless read of a block's content doc materializes a decorator
 * back to its token text instead of dropping it, and a headless write
 * materializes a token in the runs back into its node.
 *
 * Read at call time, never memoized (same rule as {@link blockTextProtectedSpans}).
 */
export function blockTextServerExtensions(): readonly InlineTokenExtension[] {
  return nodeContributions().map(({ id, pattern, node }) =>
    tokenExtension({ id, pattern, node }),
  );
}

/**
 * The Lexical classes those extensions materialize, for a headless editor's
 * `nodes` config — deduplicated by type, since several patterns legitimately
 * feed one node and Lexical rejects a type registered twice.
 *
 * These are the HEADLESS classes (`decorate()` returns null, `createDOM()`
 * throws), which is the right half for a server: same type string and same
 * fields as the browser's decorated subclass, so a doc a browser wrote hydrates
 * here and reads back identically.
 *
 * Read at call time, never memoized (same rule as {@link blockTextProtectedSpans}).
 */
export function blockTextServerNodes(): Klass<LexicalNode>[] {
  const byType = new Map<string, Klass<LexicalNode>>();
  for (const { node } of nodeContributions()) {
    if (!byType.has(node.type)) byType.set(node.type, node.Node);
  }
  return [...byType.values()];
}

/**
 * Every registered provider's answer for `rows`, merged into one block id →
 * attribute record map — what a markdown read stamps onto its nodes as
 * `MarkdownNode.annotations`.
 *
 * Read at call time, never memoized, for the same reason `blockTextProtectedSpans`
 * is: a snapshot taken before `collectContributions` would silently degrade to
 * "no annotations", which reads exactly like a TODO nobody has dispatched.
 *
 * Providers run CONCURRENTLY — they are independent queries over the same rows —
 * and two of them claiming one `(block, attribute)` pair is a defect, not a
 * last-write-wins: the value a document shows would depend on contribution
 * order, and the two owners would each believe they own it. So it throws,
 * naming both.
 */
export async function resolveBlockAnnotations(
  rows: readonly { id: string; type: string; data: unknown }[],
): Promise<ReadonlyMap<string, Record<string, string>>> {
  const providers = Editor.BlockAnnotation.getContributions();
  const merged = new Map<string, Record<string, string>>();
  if (providers.length === 0) return merged;

  const answers = await Promise.all(
    providers.map(async (p) => ({
      owner: p._pluginId ?? "<unknown>",
      byBlock: await p.resolve(rows),
    })),
  );

  /** `blockId → attribute → the plugin that already claimed it`. */
  const claimedBy = new Map<string, Map<string, string>>();
  for (const { owner, byBlock } of answers) {
    for (const [blockId, record] of byBlock) {
      for (const [name, value] of Object.entries(record)) {
        let claims = claimedBy.get(blockId);
        if (!claims) {
          claims = new Map();
          claimedBy.set(blockId, claims);
        }
        const previous = claims.get(name);
        if (previous !== undefined) {
          throw new Error(
            `Two Editor.BlockAnnotation providers claim the \`${name}\` attribute of block ` +
              `${blockId}: ${previous} and ${owner}. An externally-owned attribute must have ` +
              "exactly one owner.",
          );
        }
        claims.set(name, owner);
        let target = merged.get(blockId);
        if (!target) {
          target = {};
          merged.set(blockId, target);
        }
        target[name] = value;
      }
    }
  }
  return merged;
}
