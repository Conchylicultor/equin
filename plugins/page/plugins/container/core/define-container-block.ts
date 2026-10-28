import type { IconRef } from "@plugins/ui/plugins/icons/core";
import type { z, ZodObject } from "zod";
import {
  defineBlock,
  type BlockHandle,
  type BlockMarkdown,
} from "@plugins/page/plugins/editor/core";

/**
 * The type-level rejection of a text-bearing container: `unknown` (a no-op
 * intersection member) for a void schema, and an object carrying an
 * impossible-to-supply property for a schema whose shape declares `text`, so the
 * call site fails with "Property
 * `__void_container_schema_must_not_declare_text` is missing".
 *
 * This is the same fact `defineBlock` derives `acceptsText` from at runtime
 * (`"text" in schema.shape`), restated in the type system so a text-bearing
 * container is a COMPILE error rather than a runtime surprise. It rejects both
 * ways of becoming text-bearing:
 *
 * - `textBlockSchema({})` — the branded factory every text block composes; its
 *   shape declares `text`;
 * - a hand-rolled `z.object({ text: … })`, which carries no `TextBearingSchema`
 *   brand at all and would slip past a brand-only check while still being
 *   text-bearing at runtime.
 *
 * Keying on the shape rather than on the brand is deliberate: the shape is what
 * the runtime derivation reads, so the compile-time and runtime answers cannot
 * disagree. `S = any` (a dynamically built schema) fails CLOSED — `keyof any`
 * includes `"text"` — which is the safe direction, and the runtime guard below
 * then reports it properly.
 *
 * A conditional intersection member rather than a constraint on `S`:
 * intersecting `ZodObject` with a narrowed `shape` breaks assignability
 * outright (zod's `keyof()._cache` is derived from the shape, so `Set<"color" |
 * …>` stops being assignable to `Set<never>`) and rejects every schema,
 * including void ones.
 */
export type RejectTextBearing<S extends ZodObject> =
  "text" extends keyof S["shape"]
    ? { __void_container_schema_must_not_declare_text: never }
    : unknown;

/**
 * The declaration surface of a void container. Deliberately much smaller than
 * `defineBlock`'s: everything a container cannot coherently declare is simply
 * absent, so an inconsistent container is unrepresentable rather than merely
 * discouraged.
 *
 * Forced by the factory (not accepted here): `anchor`, `wrapOnConvert`.
 *
 * Absent because an anchor renders no line of its own, so they would be inert:
 * `placeholder`, `marker` / `ordinalMarker`, `textVariant`,
 * `gutterFirstLineCenter` (the surface seats the decoration on the first
 * child's borrowed line), `splitInto` / `splitChildWhenExpanded` /
 * `dataOnSplit` (a void row never splits), `resetToOnBackspaceAtStart` /
 * `breakOutOnEmptyEnter` (no caret can originate in it), `toggle` and
 * `defaultText`.
 */
export interface ContainerBlockOptions<S extends ZodObject> {
  /** The block type id, e.g. `"callout"`. */
  type: string;
  /** The container's appearance-only payload. Must not declare `text`. */
  schema: S;
  /** Insert-menu label. A container without one is not offered in the palette. */
  label?: string;
  /** Insert-menu icon. */
  icon?: IconRef;
  /** Alternate insert-menu search terms. */
  aliases?: string[];
  /** The default payload for a freshly inserted container. */
  empty?: () => z.infer<S>;
  /**
   * Per-type markdown. A void container has no text of its own, so the central
   * orchestrator's DEFAULT is already the right thing: the derived
   * `<type …>…</type>` tag, with the container's appearance payload projected
   * onto its attributes and its children serialized inside. Declare this only to
   * pick a different tag name or a prettier attribute form.
   */
  markdown?: BlockMarkdown<z.infer<S>>;
  /**
   * Typed prefixes that WRAP the line into this container (e.g. `"TODO "`).
   *
   * A container's prefix is a TYPING trigger by construction — that is the only
   * one of `defineBlock`'s two prefix fields it can declare. `markdownPrefixes`
   * is markdown line syntax, and markdown syntax for a container is its `<tag>`;
   * a prefix could never parse into one anyway (a void type has no text lens, so
   * no line parser is derived from it).
   *
   * `MarkdownShortcutPlugin` reads it on TYPING, strips the prefix from the live
   * editor and calls `convertTo` — which, for a `wrapOnConvert` type, wraps. So
   * the line the user was typing becomes the container's first child with the
   * prefix removed, exactly as `/<container>` on that line would have.
   *
   * Declare one only for a marker distinctive enough that real prose starting
   * with it is vanishingly rare: the conversion is silent and mid-sentence.
   */
  typingPrefixes?: string[];
}

/**
 * Define a VOID CONTAINER block type: one that owns no text at all, whose
 * displayed content IS its children.
 *
 * The two container facts are FORCED here rather than copied per block type,
 * because they are not independent — each one is load-bearing for the others,
 * and the `/context` regression this factory was extracted from was exactly the
 * result of declaring them piecemeal:
 *
 * - **`anchor: true`** — the type renders no line. The surface collapses its row
 *   to zero height while it has visible children and paints its decoration in
 *   the indent gutter; the pure reducer reads the same fact
 *   (`BlockOpContext.anchorTypes`) for its split/merge refusals and the
 *   childless-anchor prune. Because the container owns no line, converting its
 *   first child to a heading cannot touch it, and Enter in a child is a plain
 *   sibling split rather than a second container.
 *   Because it owns no line it also owns no chevron — its fold rides on the line
 *   it borrows (`resolveRailSeats`), whose rail the container OWNS, so that
 *   rail's popover carries the Collapse fallback for the cases the single
 *   chevron slot cannot serve.
 * - **`wrapOnConvert: true`** — `/<container>` on an existing block WRAPS it:
 *   the origin keeps its id, type, `data` and children and becomes the anchor's
 *   first child. A void type has nowhere to put the retyped block's text, so a
 *   swap would silently drop it; and keeping the origin's id is what keeps the
 *   caret still (its content `Y.Doc`, its content owner and its registered
 *   focus handle are all keyed by block id). It is also what lets the
 *   container's first visible line be a heading, a to-do, an image or a code
 *   block.
 *
 * The runtime guard is belt-and-braces for a caller reaching this through
 * `any` (a JS caller, a dynamically built schema): the type-level constraint
 * already rejects a text-bearing schema, and this makes the failure loud at
 * module eval instead of silently minting a text-bearing container.
 *
 * ## The return type PROVES the handle is text-less
 *
 * `defineBlock` returns a handle whose `text` lens is present-or-absent
 * depending on its schema, so a caller holding a `BlockHandle<T>` alone cannot
 * tell. A container's voidness is already guaranteed twice over here — at the
 * type level by `RejectTextBearing<S>` and at runtime by the throw below — so
 * the `& { text?: undefined }` intersection states a fact the function has
 * ALREADY established rather than asserting a new one.
 *
 * Without it the guarantee stops at this boundary: `Editor.Block`'s
 * registration is a type-level union whose text-less arm requires exactly that
 * proof (a text-bearing block may not name its own `component`), so every
 * container would fail to register despite being void by construction. Stating
 * it here fixes that once, for every container, at the one place voidness is
 * decided.
 *
 * `anchor: true` is stated for the same reason and reads the same way: the
 * handle's own field is `anchor?: true`, i.e. `true | undefined`, so a value
 * that merely *happens* to carry it is indistinguishable from one that does not.
 * Coming out of THIS function it is a certainty, and saying so is what lets
 * `Editor.Block`'s registration union give a container its own arm — the arm on
 * which `caret` is unspellable, because an anchor renders no line for a caret to
 * land on. Anchorhood is already "you went through this factory"; this makes
 * that provable to a type rather than only to a reader.
 */
export function defineContainerBlock<S extends ZodObject>(
  opts: ContainerBlockOptions<S> & RejectTextBearing<S>,
): BlockHandle<z.infer<S>> & { text?: undefined; anchor: true } {
  if ("text" in opts.schema.shape) {
    throw new Error(
      `defineContainerBlock("${opts.type}"): a container is a VOID block — its schema must not ` +
        "declare `text`. Its content IS its children; a text-bearing container fuses container " +
        "identity with a line of content, which is the exact model this primitive replaces.",
    );
  }
  // The guard member carries no data — drop it by widening to the declaration
  // surface, so the forwarding stays a spread and a new option needs no edit here.
  const declared: ContainerBlockOptions<S> = opts;
  return defineBlock({
    ...declared,
    anchor: true,
    wrapOnConvert: true,
  });
}
