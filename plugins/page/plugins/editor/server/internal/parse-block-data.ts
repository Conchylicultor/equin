import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import {
  asBlockData,
  type BlockData,
} from "@plugins/page/plugins/block-entity/core";
// Deep relative imports on purpose: this file is in every `tables.ts` schema
// graph (via the server barrel), which drizzle-kit must load SYNCHRONOUSLY —
// the core barrel would pull the async lexical/yjs bridges in with it.
import {
  PAGE_BLOCK_TYPE,
  pageData,
  pageKindOf,
  samePageKind,
  withPageKind,
  type PageKind,
} from "../../core/schemas";
import { runsOf } from "../../core/rich-text";
import { blockAuthorOf } from "../../core/define-block";
import { markdownTagNameOf } from "../../core/markdown";
import { resolveBlockHandle } from "./block-registry";

/**
 * Validate a block's `data` against its type's schema and mint the branded
 * {@link BlockData}. THE sole WRITE-side minting site: the `page_blocks.data`
 * column's type is `BlockData`, so every write funnels through here and skipping
 * validation is a compile error, not a convention. (The read side re-establishes
 * the brand by provenance, in the column's own decoder — see `asBlockData`.)
 *
 * Unknown keys are a LOUD 400, never stripped: silently canonicalizing the write
 * would hide the class of bug this boundary exists to catch (e.g. `text` injected
 * into a void block type). Absent `data` falls back to the type's `empty()` so a
 * `page` created without a body materializes `{ title, icon }` rather than `{}`.
 *
 * `.strict()` is TOP-LEVEL only — nested objects (page `cover`, text runs) keep
 * zod's default strip. That is a deliberate, known scope limit.
 */
export function parseBlockData(type: string, data: unknown): BlockData {
  const handle = resolveBlockHandle(type);
  if (!handle) throw new HttpError(400, `Unknown block type "${type}"`);

  const source = data ?? handle.empty?.() ?? {};
  // Canonicalize a string `data.text` to runs BEFORE the strict parse: the
  // persisted shape is runs-only (the `string | RichText` union is retired), so a
  // string would now fail validation. This is the compat seam for history
  // restore, which replays pre-migration `entity_versions` snapshots whose
  // `data.text` is still a string. Gated on `acceptsText` AND on `text` being
  // PRESENT — a MISSING `text` on a text-bearing type must stay a loud 400, never
  // be materialized as `[]`.
  const normalized =
    handle.acceptsText &&
    source &&
    typeof source === "object" &&
    "text" in source
      ? {
          ...(source as object),
          text: runsOf((source as { text?: unknown }).text),
        }
      : source;

  // The type's cross-field invariant (`BlockHandle.refine`) is part of what
  // "valid" means, so it runs on the same strict parse and fails the same 400.
  const strict = handle.schema.strict();
  const refine = handle.refine?.bind(handle);
  const result = (
    refine ? strict.superRefine((d, ctx) => refine(d, ctx)) : strict
  ).safeParse(normalized);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new HttpError(
      400,
      `Invalid data for block type "${type}": ${issues}`,
    );
  }
  // A strict parse against the type's own schema is exactly what "validated
  // block data" means, so this is what the brand is minted from. The cast itself
  // lives in `asBlockData`, the one place it is spelled.
  return asBlockData(result.data);
}

declare const blockDataRewriteBrand: unique symbol;

/**
 * Validated `data` for an UPDATE of an existing row — {@link BlockData} that has
 * also been proven not to change whose words the row holds. Type-only brand; a
 * sub-brand of `BlockData`, so it is still accepted wherever an insert is.
 *
 * `BlockColumnChanges.data` (`forest-writer.ts`) takes THIS brand and not the
 * plain one, so every path that rewrites an existing row's payload — the op
 * reducer's persist, the patch writer, `PATCH /api/blocks/:id`, history restore,
 * turn-into-page — is a tsc error until it goes through {@link rewriteBlockData}
 * (or, for the one write that is ABOUT the author, {@link rekindPageData}).
 * A create stays free: `NewBlockRow.data` is plain `BlockData`, because a new
 * row has no author to keep.
 */
export type BlockDataRewrite = BlockData & {
  readonly [blockDataRewriteBrand]: never;
};

/**
 * The DATA-EDIT minting site for {@link BlockDataRewrite}: validate `next` as a
 * {@link parseBlockData} does, and — when the row keeps its type — refuse a
 * payload that changes the row's KIND — the tag spelling its data selects — or
 * its AUTHOR (409). The brand has one other minter, {@link rekindPageData}, which
 * changes the kind and nothing else.
 *
 * `global` on an instructions page is deliberately NOT part of that refusal: it
 * selects no spelling and moves no author, and it is the same plain data field
 * the inline `<instructions>` card flips from its menu. The header control writes
 * it through `setPageKind` all the same, beside the kind it belongs to.
 *
 * The one row whose author lives in its data today is a page: `data.author ===
 * "agent"` makes it an agent-authored page, whose whole content an agent may
 * write (`research/2026-09-11-page-agent-pages.md`). That marker is the page's
 * KIND, chosen when the page is born and changed afterwards only by
 * `rekindPageData` — the `setPageKind` op behind the page header's kind control
 * (`research/2026-09-15-page-agent-page-follow-ups.md`). Every page-data writer
 * spreads `{...pageData(page), title}` and so carries it through; one that did
 * not — a stale client, a hand-written PATCH, a history snapshot — would
 * silently hand a human's page to an agent's pen, or take an agent's page away
 * from it. Neither is a data edit, so neither is expressible as one: a data edit
 * cannot carry an author change, and an author change carries no data edit.
 *
 * Generic, and it names no field: the comparisons are `markdownTagNameOf` and
 * `blockAuthorOf` over the handle, before and after, so a future data-decided
 * kind or author is covered by construction.
 *
 * A TYPE change is not judged here: a type's author is a different question
 * (`agent-note` → `context` is a retype, and every type transition into or out of
 * `page` is refused or special-cased at the handlers), and turn-into-page — the
 * one sanctioned way INTO a page, the only place a page is born agent-authored
 * in place — mints through here with a type change for exactly that reason.
 */
export function rewriteBlockData(args: {
  /** The type the row will hold after this write. */
  type: string;
  /** The row as it is stored now. */
  before: { type: string; data: unknown };
  /** The payload being written. */
  next: unknown;
}): BlockDataRewrite {
  const { type, before, next } = args;
  const data = parseBlockData(type, next);
  if (before.type === type) {
    // `parseBlockData` resolved (or threw for) this same handle just above.
    const handle = resolveBlockHandle(type)!;
    // The KIND of row first: a spelling is selected by discriminator values in
    // the row's data (`BlockTag.spellings` — `<page>` / `<agent-page>` /
    // `<instructions-page>`), so a payload that selects a different spelling is
    // a change of what the row IS, never a data edit.
    const wasTag = markdownTagNameOf(handle, before.data);
    const nowTag = markdownTagNameOf(handle, data);
    if (wasTag !== nowTag) {
      throw new HttpError(
        409,
        `Cannot turn a <${wasTag ?? type}> into a <${nowTag ?? type}> by rewriting its ` +
          `data: a data edit never changes which kind of "${type}" a block is. Carry ` +
          `the stored value through unchanged.`,
      );
    }
    // An absent author is the human's, so the two are compared as one.
    const was = blockAuthorOf(handle, before.data) ?? "human";
    const now = blockAuthorOf(handle, data) ?? "human";
    if (was !== now) {
      throw new HttpError(
        409,
        `Cannot change whose words a "${type}" block holds (from ${was} to ${now}) ` +
          `by rewriting its data: a data edit never changes the author. Carry the ` +
          `stored value through unchanged.`,
      );
    }
  }
  // `data` came out of the strict parse above, and the author check has passed:
  // exactly the two facts the brand states.
  return data as BlockDataRewrite;
}

/**
 * The OTHER minting site for {@link BlockDataRewrite}: a page's stored `data`
 * with its KIND set to `kind` (`withPageKind` — the `author` / `instructions` /
 * `global` keys), and every other key copied verbatim — the whole write of the
 * `setPageKind` op (`handle-set-page-kind.ts`).
 *
 * It is the mirror of {@link rewriteBlockData}, and the pair is what keeps the
 * two changes apart. `rewriteBlockData` takes a caller's payload and refuses one
 * that moves the kind or the author; this takes NO payload — only the stored row
 * and the kind to give it — so a kind change cannot smuggle a title, an icon or
 * a cover along with it, and a data edit still cannot smuggle a kind change.
 *
 * The result is re-validated through {@link parseBlockData} (the page's
 * exclusivity invariant included), so a stored blob that no longer parses is
 * still a loud 400 here rather than a brand minted over it.
 *
 * Page-specific on purpose, where `rewriteBlockData` is generic: the keys it
 * writes are the page's own. A non-page row reaching it is a caller's bug,
 * refused (400) rather than written.
 */
export function rekindPageData(args: {
  /** The page row as it is stored now, read under the page's lock. */
  before: { type: string; data: unknown };
  /** What the page becomes. */
  kind: PageKind;
}): BlockDataRewrite {
  const { before, kind } = args;
  if (before.type !== PAGE_BLOCK_TYPE) {
    throw new HttpError(
      400,
      `Only a page has a kind to change; this block is a "${before.type}".`,
    );
  }
  if (
    typeof before.data !== "object" ||
    before.data === null ||
    Array.isArray(before.data)
  ) {
    throw new Error(
      `A stored page's data is not an object (${JSON.stringify(before.data)}).`,
    );
  }
  const data = parseBlockData(
    PAGE_BLOCK_TYPE,
    withPageKind(before.data as Record<string, unknown>, kind),
  );

  // What the brand is minted FOR: the row now reads as `kind`, through the same
  // lens every consumer reads it with. A mismatch means `withPageKind` and
  // `pageKindOf` have drifted apart — a bug in core, not in the request.
  const now = pageKindOf(pageData({ data }));
  if (!samePageKind(now, kind)) {
    throw new Error(
      `rekindPageData wrote a page that reads as ${JSON.stringify(now)}, not ${JSON.stringify(kind)}.`,
    );
  }
  return data as BlockDataRewrite;
}
