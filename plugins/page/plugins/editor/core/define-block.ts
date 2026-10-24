import type { IconRef } from "@plugins/ui/plugins/icons/core";
import type { ClassName } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import type { AnyZodObject, z } from "zod";
import { runsOf, type RichText } from "./rich-text";
import { rowDataOf, type RowData } from "./row-data";
import type { TextBearingSchema } from "./text-data";
import type { BlockMarkdown } from "./markdown";
import type { BlockSemantics } from "./block-semantics";

/**
 * The semantic typography roles an editable-text block can render at. Mirrors the
 * `TextVariant` set from `primitives/text`, redeclared here because core cannot
 * import from a web barrel — the web renderer maps each role to its `text-<role>`
 * utility. `body` is the default for ordinary text blocks.
 */
export type BlockTextVariant =
  "title" | "heading" | "subheading" | "body" | "label" | "caption";

/**
 * Who a block's content is FOR — see {@link BlockHandle.audience}. Two values,
 * and deliberately no third: an annotation card is either something an agent may
 * receive or something withheld from it, and a middle value would have to mean
 * something to every consumer that filters on it.
 */
export type BlockAudience = "agent" | "human";

/**
 * Whose words a block holds, and therefore who may write it — see
 * {@link BlockHandle.author}. The same two values as {@link BlockAudience}, and
 * deliberately the same two spellings: a page has exactly two parties, and
 * giving one of them a second word (`"user"` on one axis, `"human"` on the
 * other) is how a policy ends up comparing strings drawn from two vocabularies
 * and quietly matching neither.
 */
export type BlockAuthor = "agent" | "human";

export interface BlockHandle<T> {
  type: string;
  schema: AnyZodObject;
  parse(data: unknown): T;
  /**
   * Non-throwing twin of `parse`, typed against the block's own data. Defensive
   * readers (data may be transient/empty mid-edit) use this instead of
   * `schema.safeParse` — the interface erases `schema` to `AnyZodObject`, whose
   * `safeParse` result is untyped.
   */
  safeParse(
    data: unknown,
  ): { success: true; data: T } | { success: false; error: z.ZodError };
  /**
   * Whether this block type carries editable text — DERIVED once from the schema
   * (`"text" in schema.shape`), never inferred from a type name. Consumers use it
   * to decide whether to carry `text` through a type conversion: injecting `text`
   * into a void block type (audio, divider, …) whose schema never declared it would
   * write a key the write boundary now rejects with a 400.
   */
  acceptsText: boolean;
  /**
   * Typed text lens — present IFF this block type is text-bearing (its schema
   * came from `textBlockSchema`). `handle.text(data)` is THE single reader that
   * turns the block's own `data` into canonical `RichText`, coercing the legacy
   * `string | RichText` union via `runsOf`. Generic consumers read text through
   * this rather than dereferencing `data.text` — which was duck-typed as a string
   * and silently produced `""` for the runs array. Void block types have
   * `text: undefined` at runtime and type level. Installed off `acceptsText`.
   *
   * Declared in METHOD syntax deliberately: methods are checked bivariantly, so
   * a concrete `BlockHandle<{text: …}>` stays assignable to the registries'
   * `BlockHandle<unknown>` (a property-typed function would be contravariant in
   * `data` and break every `Editor.BlockData(handle)` call site).
   */
  text?(data: T): RichText;
  /**
   * Per-type markdown serialize/parse. When present it fully owns this block's
   * clipboard markdown; when absent the central orchestrator derives it from the
   * text lens + `markdownPrefixes`. Typed against the block's own inferred data,
   * so a field rename is a compile error in the block's own function instead of a
   * silent empty line — the class of bug the June-16 `data.text` string→runs
   * migration caused when generic code duck-typed `data.text`.
   *
   * A hand-written `markdown.parseLine` must also declare the lines it takes
   * (`parseLine.claims`), because a closure's language cannot be enumerated:
   * `markdownPrefixes` states its own claim, `/^\d+[.)]\s+(.*)$/` states it to
   * nobody but the regex engine, and the serializer's escape rests on knowing
   * who claims a line. `page.editor:markdown-claims-are-escapable` holds every
   * declared sample to being claimed by its declarer and to being defeated by
   * one leading backslash.
   */
  markdown?: BlockMarkdown<T>;
  /**
   * Optional insert-menu label (e.g. "Text", "Link to page"). A block type
   * without a `label` is not offered in the editor's "add block" menu.
   */
  label?: string;
  /**
   * Marks THE plain-paragraph type: the block the editor falls back to whenever
   * it must create text the user never picked a type for — Enter from the page
   * title, a click below the last block, a markdown paragraph on paste. Exactly
   * one block type declares it (`page/text`), and `defaultTextHandle` selects it
   * by this flag alone. Declared, never inferred: the old "no prefix, no marker,
   * no toggle, has a label" heuristic silently matched whichever void block type
   * (audio, bookmark, …) happened to register first.
   */
  defaultText?: boolean;
  /** Optional insert-menu icon. */
  icon?: IconRef;
  /**
   * Optional alternate search terms for the insert menus (e.g. `["hr", "rule"]`
   * for a divider). The block-type pickers match these in addition to `label`,
   * but rank them below label matches. Only meaningful for block types that also
   * declare a `label` (presence of `label` is what gates menu inclusion).
   */
  aliases?: string[];
  /** Returns the default `data` payload for a freshly inserted block. */
  empty?: () => T;
  /**
   * The default payload minus the projection-owned `text` key — DERIVED from
   * `empty()`, never declared. `empty()` seeding `{ text: [] }` is correct at
   * block CREATION (a brand-new id has no content doc, so its row is the only
   * seed); a CONVERSION keeps the block's id and therefore its doc, so the row's
   * text must be left alone. Every `convertTo` call site seeds from here so none
   * of them hand-strips.
   *
   * Declared in METHOD syntax deliberately — see the bivariance note on `text`.
   */
  emptyRowData(): RowData;
  /**
   * This type's canonical MARKDOWN LINE SYNTAX (e.g. `["* ", "- ", "+ "]` for a
   * bulleted list, `["# "]` for an H1). It feeds the clipboard markdown pipeline
   * — `outputPrefix` emits the FIRST entry, `derivedParsePrefixes` claims them
   * all on parse — and, as a superset consumer, the typing-time shortcut
   * (`conversionPrefixesOf`): real markdown syntax is always also something the
   * user may type.
   *
   * Declare a prefix here ONLY if a line starting with it genuinely means this
   * block type in markdown. A prefix that merely *converts on typing* is a
   * {@link typingPrefixes} entry — see the note there for why conflating the two
   * turned a pasted markdown table into a wall of quote blocks.
   */
  markdownPrefixes?: string[];
  /**
   * Leading text that auto-converts a block into this type when TYPED at line
   * start, but which is NOT markdown line syntax (e.g. `["| "]` for a quote,
   * `["[] "]` for a to-do, ` ``` ` for a code block). The shared text editor
   * strips the matched prefix and converts via `BlockEditorAPI.convertTo`,
   * preserving any trailing text; the markdown pipeline never sees these.
   *
   * The split exists because the two mechanisms genuinely disagree. `| ` is a
   * fine quote shortcut — nothing else in the editor starts a line with it — but
   * in markdown it is a TABLE ROW, so a single field feeding both would make
   * `derivedParsePrefixes` claim it and turn every row of a pasted table into a
   * quote block. Declaring it here keeps the typing affordance and leaves the
   * parser alone.
   */
  typingPrefixes?: string[];
  /**
   * Backspace at the very start of this block first converts it to this type
   * (keeping text + children) instead of merging — Notion's "reset block type".
   * A second Backspace then merges. Generic: the editor core never names a
   * specific block type (the target is supplied here, e.g. `"text"`).
   */
  resetToOnBackspaceAtStart?: string;
  /**
   * Enter on an EMPTY block of this type converts it to this type instead of
   * splitting — exits a list / breaks a quote out to a paragraph. Generic: the
   * editor core never names a specific block type.
   */
  breakOutOnEmptyEnter?: string;
  /**
   * For editable-text block types: a static glyph rendered to the left of the
   * text (e.g. `"•"` for a bullet). Text-like block types that share the editor
   * plugin's `BlockTextRenderer` all resolve to the *same* renderer function, so
   * converting between them reconciles in place (the live editor and its caret
   * survive) rather than remounting.
   */
  marker?: string;
  /**
   * For editable-text list blocks whose marker is its 1-based position among the
   * consecutive run of same-type siblings (an ordered list). The shared renderer
   * draws `ordinalMarker(n)` as the leading glyph; markdown paste routes N./N)
   * lines to this type and copy emits real sequential numbers. The
   * position-derived analogue of `marker` — generic, the editor core never names
   * a specific block type.
   */
  ordinalMarker?: (ordinal: number) => string;
  /** For editable-text block types: placeholder shown when empty and focused. */
  placeholder?: string;
  /** Semantic typography variant for the editable text (default "body"). */
  textVariant?: BlockTextVariant;
  /**
   * What this block's LINE is in the accessibility tree — a heading, today. The
   * shared skeleton turns it into `role` / `aria-level` on the one element whose
   * content is exactly the text (`TextBlockLayout`'s leaf cell), on BOTH the
   * editable and the read-only surface.
   *
   * Distinct from `textVariant`, which is a font-size role: deriving "is a
   * heading" from "renders large" is how a big paragraph starts announcing as a
   * heading. Distinct from `chrome` too — that is styling plus sibling regions,
   * and an accessibility role is neither.
   *
   * Text-bearing types only, enforced at the type level (`SemanticsFor`): a void
   * or container type has no line to describe. See {@link BlockSemantics} for
   * why the union is closed and what it therefore cannot express (list items,
   * blockquotes).
   */
  semantics?: BlockSemantics;
  /**
   * Where the gutter controls (+ / drag / chevron) seat vertically: a CSS length
   * from the block's TOP edge to the CENTER of its first rendered line, which is
   * where the controls center.
   *
   * The default suits a block that renders editable text through the shared
   * `BlockTextEditor` at the standard inset — `py-xs + textVariant-line-height/2`
   * — so ordinary text blocks omit this. A block that renders its first line at a
   * different offset (a padded box like the callout, an icon row like
   * link-to-page / sub-page, a rule like the divider) declares its real center
   * here so the rail tracks that line instead of a phantom text line. Media/void
   * blocks with no single line can omit it: the default seats the controls near
   * the block's top-left, the intended treatment for tall content.
   *
   * Express it in the same tokens the block's layout uses (e.g.
   * `calc(var(--space-xs) * 2 + var(--doc-lh-body) / 2)`) so it tracks the
   * density preset and can't drift from the padding it mirrors.
   */
  gutterFirstLineCenter?: string;
  /**
   * The type of the TAIL an Enter-split mints — the block carrying the text
   * after the caret, or (at the end of the line) the empty block the user types
   * the next thing into. A heading declares `"text"`, so splitting it anywhere
   * in its line yields a body paragraph. Defaults to this same type, which is
   * what a list item wants: splitting a bullet yields another bullet.
   *
   * Applies wherever the tail lands — next sibling, or nested first child. The
   * one Enter it does NOT govern is at the START of a non-empty block, which
   * mints an empty HEAD above instead of a tail and so keeps this type.
   */
  splitInto?: string;
  /**
   * Transform the data payload the TAIL inherits when a split produces a tail of
   * the SAME type (e.g. a checked to-do splits into an unchecked one). Resolved at
   * the intent layer and carried through the op as `tailData` — the pure reducer
   * cannot see handles. `text` is overwritten with the after-runs regardless.
   *
   * Declared in METHOD syntax deliberately (same trap `text` documents above): a
   * property-typed function is contravariant in `data` and breaks the registries'
   * `BlockHandle<unknown>` assignability.
   */
  dataOnSplit?(data: T): T;
  /**
   * For text block types with a boolean state: the shared text renderer renders
   * an interactive checkbox marker bound to `data[field]`, and applies
   * `doneClassName` (default: strikethrough + muted) to the text content when the
   * field is truthy. Generic — the renderer never names a specific block type.
   */
  toggle?: { field: string; doneClassName?: ClassName };
  /**
   * When "always", the editor shows the collapse chevron for this block type even
   * when it has no children yet (used by the toggle block, and by `sub-page` /
   * `page-link`, whose chevron is not a fold at all — it drives the composite
   * union's page MOUNT). Omitted = the chevron appears only when the block
   * actually has children.
   *
   * There is deliberately no `"never"`. It existed for one reason — an `anchor`
   * renders no line, so it had no chevron to reopen itself with, and a stored
   * `expanded: false` would have hidden its children behind nothing — and that
   * reason is gone: a collapsed container now folds to its BORROWED line
   * (`visibleChildRule`), which always paints and always carries the chevron
   * back out. Inertness was a way to make a flag harmless; showing one line is a
   * way to make it meaningful.
   */
  collapsible?: "always";
  /**
   * This block type is a container ANCHOR: it renders no line of its own. Its
   * content IS its children. The surface collapses its row to zero height while
   * it has visible children and paints its decoration in the indent gutter left
   * of the first child; with no children the row falls back to a single empty
   * line, so the container is never an invisible, unclickable row. Generic — the
   * editor core never names a block type.
   *
   * It lives in `core` because the pure REDUCER needs it (`BlockOpContext`'s
   * `anchorTypes`: the empty-anchor prune and the split/merge refusals) and the
   * server has no slots. The *decoration component* rides on the web
   * `Editor.BlockFrame` contribution instead — so a type cannot claim anchorhood
   * without actually registering as a container — and a `./equin check`
   * pins the two together (a handle declaring `anchor: true` whose plugin
   * contributes no anchor component fails the check).
   */
  anchor?: true;
  /**
   * Converting a block INTO this type is a WRAP, not a type swap: the origin row
   * keeps its id, type, data and children and becomes the FIRST CHILD of a newly
   * minted row of this type. Both rows are minted in ONE patch, so it is one undo
   * entry.
   *
   * Keeping the origin's id is load-bearing — its per-block content `Y.Doc`, its
   * content owner and its registered `BlockFocusHandle` are all keyed by block
   * id, so the caret simply stays put. Generic — resolved inside `convertTo`, so
   * every caller (`/` menu, gutter-`+` draft, Turn-into, url-paste) is unchanged.
   */
  wrapOnConvert?: true;
  /**
   * Who this block's content is FOR. Declared ONLY by annotation containers
   * (`page/annotations`' `defineAnnotationBlock`, which requires it); **absent
   * means ordinary page content, visible to everyone** — a paragraph is not
   * withheld from anybody, so an unmarked block is not a hole in a policy, it is
   * the common case.
   *
   * It rides the HANDLE deliberately. The handle is already what
   * `Editor.BlockData.getContributions()` hands the server, so a consumer that
   * must withhold human-only content (the agent-facing markdown read path)
   * resolves the audience from the registry it already reads — there is no
   * second registry that could drift from the first, and no way for a block type
   * to exist in one and not the other.
   *
   * Consumers enumerate GENERICALLY (`handles.filter(h => h.audience ===
   * "human")`) and never name a block type. That is what makes a fifth
   * annotation zero edits in the delivery path, and what stops a redaction from
   * silently missing the one type it forgot to list.
   *
   * `defineBlock` does NOT accept it, and that is the fail-safe half: only
   * `defineAnnotationBlock` sets it, so its presence on a handle *is* the proof
   * that the type went through the factory that makes it mandatory. The
   * `annotations:parties-declared` check keys on exactly that, which is what
   * stops a future annotation from quietly being an ordinary container and
   * defaulting into visibility.
   */
  audience?: BlockAudience;
  /**
   * Whose words this block holds, and therefore who may write it. Declared ONLY
   * by annotation containers (`page/annotations`' `defineAnnotationBlock`, which
   * requires it); **absent means the HUMAN's** — the page's own prose is not an
   * agent's to rewrite.
   *
   * That absent-value default points the OPPOSITE way from {@link audience}'s,
   * and both are the fail-safe one. Which is exactly why neither axis can be
   * derived from the other, however similar the two unions look:
   *
   * | absent     | means                                 | why that is the safe answer                   |
   * |------------|---------------------------------------|-----------------------------------------------|
   * | `audience` | ordinary content, visible to everyone | a paragraph is withheld from nobody           |
   * | `author`   | the human's                           | the page's prose is not an agent's to rewrite |
   *
   * So an unmarked block is readable by everyone and writable by nobody but the
   * person at the keyboard, which is what an ordinary paragraph is. Erring the
   * other way on either axis is the unrecoverable direction: a private card
   * handed out, or an agent that overwrote what its author typed.
   *
   * It rides the HANDLE for {@link audience}'s reason — the handle is already
   * what `Editor.BlockData.getContributions()` hands the server, so there is no
   * second registry to drift from the first — and consumers read the write rule
   * off `handle.author` GENERICALLY, never off a block type name.
   *
   * `defineBlock` does NOT accept it, which is the same fail-safe half
   * {@link audience} relies on: presence on a handle *is* the proof that the
   * type went through `defineAnnotationBlock`, the factory that makes the
   * declaration mandatory. The `annotations:parties-declared` check keys on that
   * presence, for both fields at once.
   *
   * Read it through {@link blockAuthorOf}, never directly: a type whose author
   * is decided per ROW declares {@link authorFromData} instead, and a consumer
   * reading only this field would see that row as the human's.
   */
  author?: BlockAuthor;
  /**
   * Whose words a ROW of this type holds, decided from its own `data` — the
   * per-row twin of {@link author}, for a type where the answer is not the same
   * for every row. The one today is `page`: an agent-authored page (`data.author
   * === "agent"`, `<agent-page>` in markdown) is a sub-page whose whole content
   * an agent may write, and every other page is the human's. A second block type
   * was the alternative, and it would have meant widening every one of the ~46
   * sites that test `type === "page"` (see
   * `research/2026-09-11-page-agent-pages.md`).
   *
   * **Absent answer means the human's**, exactly as an absent {@link author}
   * does — a page that says nothing is the fail-safe reading.
   *
   * It is handed a PARTIAL payload by one reader — `markdownTagNamesAuthoredBy`
   * asks it about a tag spelling's preset, which carries only the discriminator
   * keys — so it must decide from the keys it reads and nothing else. That is not
   * a restriction in practice: a data-decided author is exactly what a spelling's
   * preset discriminates, which is what lets a tag's NAME say whose words it
   * holds.
   *
   * Never beside {@link author}: a handle declares one or the other. `defineBlock`
   * accepts this and not `author`; `defineAnnotationBlock` installs `author` and
   * its options (`ContainerBlockOptions`) do not forward this — so an annotation
   * can never declare both, and presence of `author` stays the
   * `annotations:parties-declared` discriminator it is.
   *
   * Declared in METHOD syntax for the bivariance reason `text` gives.
   */
  authorFromData?(data: Partial<T>): BlockAuthor | undefined;
  /**
   * A cross-field invariant of this type's payload that its object schema cannot
   * state: zod 3's `.refine` turns a `ZodObject` into a `ZodEffects`, which has
   * no `.shape` and no `.strict()`, and both are read off `schema` (the text-
   * bearing derivation, the write boundary's strict parse, the markdown
   * spelling validation). So the object stays the schema and the invariant rides
   * beside it.
   *
   * Applied by {@link parse} and {@link safeParse} (so a markdown parse refuses a
   * payload that breaks it) and by the server's `parseBlockData` (so the write
   * boundary 400s on one). The one declarer today is `page`, whose kinds —
   * agent-authored page, instructions page — are mutually exclusive.
   *
   * Declared in METHOD syntax for the bivariance reason `text` gives.
   */
  refine?(data: T, ctx: z.RefinementCtx): void;
  /**
   * Enter-split behavior. By default a block splits into a sibling of the same
   * type. A block with this set instead nests the split-off content as its FIRST
   * CHILD *when it is currently expanded* (a collapsed block still splits into a
   * sibling). `childType` is the type created for that child. Generic — used by
   * the toggle block; the editor core never names a block type.
   */
  splitChildWhenExpanded?: { childType: string };
}

/**
 * The typed text lens conditional on the schema brand: a text-bearing schema
 * (from `textBlockSchema`) gets a required `text(data)` reader; a void schema
 * gets `text?: undefined`. Keyed on the compile-time brand so the lens is present
 * exactly where the block carries text.
 */
type TextLens<S extends AnyZodObject> = S extends TextBearingSchema
  ? { text(data: z.infer<S>): RichText }
  : { text?: undefined };

/**
 * `semantics` describes a LINE, so only a text-bearing type may declare one.
 * Keyed on the same `TextBearingSchema` brand as the text lens, and shaped like
 * `defineContainerBlock`'s `RejectTextBearing`: a void type that reaches for it
 * gets a named, unsatisfiable type rather than a silently inert field.
 * (Containers never see it at all — `ContainerBlockOptions` has no such key.)
 */
type SemanticsFor<S extends AnyZodObject> = S extends TextBearingSchema
  ? BlockSemantics
  : { __semantics_requires_a_text_bearing_schema: never };

export function defineBlock<
  S extends AnyZodObject,
  // Whether this type is a container ANCHOR, captured as a LITERAL rather than
  // erased to the handle's own `anchor?: true`. The handle's optional field
  // cannot tell "a container" from "anything at all", so `Editor.Block`'s
  // registration union could not give containers their own arm — the arm where
  // `caret` is unspellable because an anchor renders no line for a caret to land
  // on. Inferred from the call site (`anchor: true` ⇒ `true`, omitted ⇒
  // `undefined`), and `defineContainerBlock` — the only sanctioned way to make a
  // container — passes the literal, so its return type states the fact.
  A extends true | undefined = undefined,
>(opts: {
  type: string;
  schema: S;
  label?: string;
  defaultText?: boolean;
  icon?: IconRef;
  aliases?: string[];
  empty?: () => z.infer<S>;
  markdown?: BlockMarkdown<z.infer<S>>;
  markdownPrefixes?: string[];
  typingPrefixes?: string[];
  resetToOnBackspaceAtStart?: string;
  breakOutOnEmptyEnter?: string;
  marker?: string;
  ordinalMarker?: (ordinal: number) => string;
  placeholder?: string;
  textVariant?: BlockTextVariant;
  semantics?: SemanticsFor<S>;
  gutterFirstLineCenter?: string;
  splitInto?: string;
  dataOnSplit?(data: z.infer<S>): z.infer<S>;
  toggle?: { field: string; doneClassName?: ClassName };
  collapsible?: "always";
  anchor?: A;
  wrapOnConvert?: true;
  splitChildWhenExpanded?: { childType: string };
  authorFromData?(data: Partial<z.infer<S>>): BlockAuthor | undefined;
  refine?(data: z.infer<S>, ctx: z.RefinementCtx): void;
}): BlockHandle<z.infer<S>> & TextLens<S> & { anchor: A } {
  // Computed once at definition: text-bearing-ness is a fact of the schema.
  const acceptsText = "text" in opts.schema.shape;
  // The schema `parse`/`safeParse` run: the object plus its cross-field
  // invariant, when the type declares one (see `BlockHandle.refine`).
  const refine = opts.refine;
  const checked = refine
    ? opts.schema.superRefine((data, ctx) => refine(data, ctx))
    : opts.schema;
  const handle: BlockHandle<z.infer<S>> = {
    type: opts.type,
    schema: opts.schema,
    acceptsText,
    // The typed text lens: canonical `RichText` from the block's own `data`,
    // coercing the legacy `string | RichText` union. Present iff text-bearing.
    text: acceptsText
      ? (data) => runsOf((data as { text?: unknown }).text)
      : undefined,
    markdown: opts.markdown,
    parse: (data) => checked.parse(data) as z.infer<S>,
    safeParse: (data) =>
      checked.safeParse(data) as
        | { success: true; data: z.infer<S> }
        | { success: false; error: z.ZodError },
    label: opts.label,
    defaultText: opts.defaultText,
    icon: opts.icon,
    aliases: opts.aliases,
    empty: opts.empty,
    emptyRowData: () => rowDataOf(opts.empty?.() ?? {}),
    markdownPrefixes: opts.markdownPrefixes,
    typingPrefixes: opts.typingPrefixes,
    resetToOnBackspaceAtStart: opts.resetToOnBackspaceAtStart,
    breakOutOnEmptyEnter: opts.breakOutOnEmptyEnter,
    marker: opts.marker,
    ordinalMarker: opts.ordinalMarker,
    placeholder: opts.placeholder,
    textVariant: opts.textVariant,
    // `SemanticsFor<S>` collapses to `BlockSemantics` on the branded (text-bearing)
    // arm and to the named error object otherwise; the value can only be the
    // former, since the latter is unsatisfiable at every real call site.
    semantics: opts.semantics as BlockSemantics | undefined,
    gutterFirstLineCenter: opts.gutterFirstLineCenter,
    splitInto: opts.splitInto,
    dataOnSplit: opts.dataOnSplit,
    toggle: opts.toggle,
    collapsible: opts.collapsible,
    anchor: opts.anchor,
    wrapOnConvert: opts.wrapOnConvert,
    splitChildWhenExpanded: opts.splitChildWhenExpanded,
    authorFromData: opts.authorFromData,
    refine: opts.refine,
  };
  // Neither intersection can be proved from the value, and each states a fact
  // already established above. `TextLens<S>`: the runtime `text` presence tracks
  // `acceptsText`, which mirrors the schema brand by construction (every text
  // block composes `textBlockSchema`). `{ anchor: A }`: `handle.anchor` IS
  // `opts.anchor`, copied one field at a time above, so it is exactly the `A`
  // the call site passed — the widening to `true | undefined` happens only in
  // `BlockHandle`'s own declaration, which has no `A` to name.
  return handle as BlockHandle<z.infer<S>> & TextLens<S> & { anchor: A };
}

/**
 * Whose words one ROW holds — THE resolution of the author axis, and the only
 * one a consumer may use: the handle's static {@link BlockHandle.author} when it
 * declares one, else the row's own answer through
 * {@link BlockHandle.authorFromData}, else `undefined` (the human's, the
 * fail-safe reading of an absent value).
 *
 * `data` is parsed through the handle's own schema before the per-row question
 * is asked, so a malformed row is a LOUD zod error rather than an author read off
 * a payload the write boundary would never have stored. A handle with no
 * per-row answer never parses at all — the common case (every paragraph) costs a
 * field read.
 */
export function blockAuthorOf<T>(
  handle: BlockHandle<T>,
  data: unknown,
): BlockAuthor | undefined {
  if (handle.author !== undefined) return handle.author;
  if (!handle.authorFromData) return undefined;
  return handle.authorFromData(handle.parse(data));
}

/**
 * Every prefix that converts a block when TYPED at line start: markdown line
 * syntax is always also a typing shortcut, plus the input-only ones.
 *
 * THE single resolution of that union, so the shortcut plugin and the
 * `page.editor:block-prefixes-unique` check read one definition — a consumer
 * hand-concatenating the two fields is how they would drift.
 */
export function conversionPrefixesOf(h: BlockHandle<unknown>): string[] {
  return [...(h.markdownPrefixes ?? []), ...(h.typingPrefixes ?? [])];
}
