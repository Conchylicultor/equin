import type { Klass, LexicalNode } from "lexical";
import type { ReactNode } from "react";

/**
 * THE declaration of an inline token family — the TYPES only.
 *
 * An inline token is a decorator node that PERSISTS AS TEXT — `[[page:<id>]]`,
 * `[[date:<iso>]]`, `\(latex\)`, `![alt](/api/attachments/<id>)`. Every such
 * family used to hand-write the same five things: a `DecoratorNode` subclass, a
 * `serializeNode` writing the token, a `deserializePattern` reading it back, a
 * `createNodeFromMatch` building the node, and a `getTextContent` decision. The
 * first and the last two could disagree with each other silently, and a stub
 * class lacking `getTextContent` made hydration SUCCEED while deleting the token
 * (the hazard `page/block-text-write/server/internal/block-doc-text.ts` warns
 * about).
 *
 * Here the family declares only what is irreducible — its type string, its field
 * names, how a field record spells its token, and how a regex match reads the
 * fields back — and everything else is derived. There is no way to obtain a node
 * class for this system except through `defineInlineTokenNode` (the `node`
 * sub-plugin), which requires `token`, so a class that serializes to `""` cannot
 * be written.
 *
 * ## Why this file holds only types
 *
 * Every `lexical` import here is `import type`, which emits NOTHING at runtime.
 * That is load-bearing: this plugin's barrel is reachable from
 * `@plugins/page/plugins/editor/server`, which drizzle-kit loads SYNCHRONOUSLY
 * when it generates migrations — and `lexical` has an async-only module in its
 * graph, so one runtime edge to it makes every page schema file unloadable and
 * its tables silently vanish from migration generation. The class factory that
 * needs `DecoratorNode` as a VALUE therefore lives one level down, in the
 * `node` sub-plugin. See this plugin's `CLAUDE.md`.
 *
 * ## Why `fields` is a LIST of names, not one blob
 *
 * `@lexical/yjs` hydrates a decorator by `new Klass()` and then copying the
 * `Y.XmlElement`'s ATTRIBUTES onto the instance as `__`-prefixed own properties
 * (`createLexicalNodeFromCollabNode` -> `$syncPropertiesFromYjs`). Which
 * properties it will ever sync is decided ONCE, at binding setup, by
 * `initializeNodeProperties`: it constructs `new klass()` with NO ARGUMENTS and
 * snapshots `Object.entries(node)`. So every field must be a separate own
 * enumerable property, present after a ZERO-ARG construction — which is why the
 * synthesized constructor seeds each `__<field>` with `""` and takes only an
 * optional `key`.
 *
 * ## Two runtimes, one class hierarchy
 *
 * The class `defineInlineTokenNode` mints is HEADLESS: `decorate()` returns null
 * and `createDOM()` throws. A browser host calls {@link InlineTokenNode.decorated}
 * to obtain a twin descriptor over a SUBCLASS that adds only rendering — same
 * type string, same fields, same token format, because they come from the same
 * declaration. The headless class is what a server (or a headless `readYDoc`)
 * registers; the decorated subclass is what a live editor registers. Never both
 * in one editor: Lexical keys its registry by type string and rejects a second
 * class for it.
 *
 * ## Why there are TWO descriptor types
 *
 * {@link InlineTokenNodeRef} is what a REGISTRY stores, and it is field-type
 * erased. {@link InlineTokenNode} is what the DECLARING plugin holds, and it
 * knows the family's `F`. The split is not decoration — it is what makes the
 * erasure a real subtype relation rather than a cast:
 *
 * A registry is a homogeneous list, so it must name ONE type for every family's
 * descriptor. If that one type were `InlineTokenNode<TokenFields>`, then storing
 * a `InlineTokenNode<PageLinkFields>` in it would ask TypeScript to accept an
 * assignment it cannot: `F` sits in a CONSUMER position on the typed half
 * (`create(fields: F)`, `tokenOf(fields: F)`, `setFields(node, Partial<F>)`),
 * and `keyof F` appears in `fields` — which makes the generic INVARIANT, so the
 * two instantiations are related in neither direction. Every registration site
 * became a type error, and the only way to keep one type was to cast the
 * variance away.
 *
 * So the erased half simply does not mention `F`. Everything a registry needs of
 * a family — name it, register its class, ask "is this node yours?", serialize
 * one of its nodes, build one from a regex match — is expressible without ever
 * accepting an `F` from the caller: the erased builder takes the MATCH and reads
 * the fields with the family's own `fieldsOf`, so the only `F` that reaches a
 * family is one it produced itself. The typed half adds the `F`-accepting
 * members and is held only by the plugin that declared the family, where `F` is
 * known. `InlineTokenNode<F> extends InlineTokenNodeRef`, so the erasure is
 * ordinary subtyping — no cast anywhere, and no unsound widening either.
 */

/** A token field's value. `null` is legitimate (an absent reminder id). */
export type TokenFieldValue = string | null;

/**
 * The fields one token carries.
 *
 * Declare a family's field record as a `type` alias of an object literal, never
 * an `interface`: TypeScript grants an implicit index signature to the former
 * only, and without it `YourFields` does not satisfy the `F extends TokenFields`
 * constraint — `defineInlineTokenNode<YourFields>` is rejected outright.
 */
export type TokenFields = Record<string, TokenFieldValue>;

// The brand. Exported so the interface below can name it, but deliberately NOT
// re-exported from `core/index.ts`, so outside this module there is no way to
// spell the key — hence no way to fabricate an `InlineTokenNode` in an object
// literal. The `node` sub-plugin, which builds the only real descriptors, stamps
// it through `brandInlineTokenNode` rather than by naming the symbol.
//
// A REAL symbol, not a `declare const`. The brand is carried as an actual
// property on every descriptor, so a type-only declaration emits nothing and
// every `defineInlineTokenNode` call would die with `ReferenceError:
// INLINE_TOKEN_NODE is not defined` at module eval. Keeping it a value also
// means the brand is checked at RUNTIME and not merely by tsc.
const INLINE_TOKEN_NODE: unique symbol = Symbol("inline-token-node");

export interface InlineTokenNodeSpec<F extends TokenFields> {
  /** The ONE spelling of the Lexical node type. */
  type: string;
  /** Field names, in declaration order -> the `__`-prefixed properties. */
  fields: readonly (keyof F & string)[];
  /** The token text a field record spells. REQUIRED — this is the anchor. */
  token: (fields: F) => string;
  /** The fields a regex match encodes; `null` when the match is not a token. */
  fieldsOf: (match: RegExpExecArray) => F | null;
  /**
   * What `getTextContent()` answers, as an explicit decision rather than an
   * accident of which base class you happened to extend.
   *
   * `"empty"` keeps the token out of live root-text reads (the page editor's
   * slash menu and its `[[` / `@` / `$$` query scans all read the root's text).
   * `"token"` puts it back in, which is what a clipboard payload needs so a chip
   * copied out of one editor re-parses in another.
   *
   * Caret math is unaffected either way: `nodePlainLength` and
   * `$xmlBasisContentLength` both go through the extension's serializer, never
   * raw `getTextContent()`.
   */
  textContent: "token" | "empty";
}

/** What a browser host adds on top of the headless class: rendering, only. */
export interface InlineTokenDecoration<F extends TokenFields> {
  /**
   * Class on the host `<span>` the decorator's React tree mounts into. The
   * host always carries `max-w-full` too, so a token never outgrows its line.
   */
  className?: string;
  /** The chip. `node` is the live instance (for `getKey()` / mutation). */
  render: (fields: F, node: LexicalNode) => ReactNode;
}

/**
 * One inline token family as a REGISTRY sees it — field-type erased on purpose.
 *
 * Not a single member accepts an `F` from its caller, which is what lets every
 * family's descriptor live in one homogeneous list (see the module header). The
 * one member that produces a node from outside data takes the regex MATCH and
 * runs the family's own `fieldsOf` on it, so a family is only ever handed fields
 * it wrote itself.
 */
export interface InlineTokenNodeRef {
  readonly [INLINE_TOKEN_NODE]: true;
  readonly type: string;
  /**
   * The `__`-prefixed properties' names, in declaration order. Erased to plain
   * strings: the narrow `keyof F & string` belongs on
   * {@link InlineTokenNodeSpec}, where it is what rejects a field name the
   * record does not have. A registry only ever needs to know WHICH names exist.
   */
  readonly fields: readonly string[];
  readonly textContent: "token" | "empty";
  /** The class to register in a Lexical editor's `nodes` config. */
  readonly Node: Klass<LexicalNode>;
  /** Is this node one of mine? Answered by TYPE, so a decorated twin counts. */
  is(node: LexicalNode | null | undefined): boolean;
  /** The token text for one of my instances; `null` when not one of mine. */
  token(node: LexicalNode): string | null;
  /** The fields a regex match encodes; `null` when not a real token. */
  fieldsOf(match: RegExpExecArray): TokenFields | null;
  /**
   * Mint an instance from a regex match — the erased twin of `create`. `null`
   * when `fieldsOf` rejects the match (image markdown pointing somewhere other
   * than an attachment), which is the same "not a token after all" answer.
   * Must run inside an `editor.update()`.
   */
  createFromMatch(match: RegExpExecArray): LexicalNode | null;
}

/**
 * One inline token family as its DECLARING plugin holds it: the erased registry
 * view plus every member that speaks the family's own field record.
 */
export interface InlineTokenNode<
  F extends TokenFields = TokenFields,
> extends InlineTokenNodeRef {
  /** Mint an instance of {@link InlineTokenNodeRef.Node}. Inside an `editor.update()`. */
  create(fields: F): LexicalNode;
  /** The fields one of my instances carries. */
  fieldsOfNode(node: LexicalNode): F;
  /** Overwrite some fields on a live instance. Inside an `editor.update()`. */
  setFields(node: LexicalNode, fields: Partial<F>): void;
  /** The token text a field record spells. */
  tokenOf(fields: F): string;
  /** The fields a regex match encodes; `null` when not a real token. */
  fieldsOf(match: RegExpExecArray): F | null;
  /** A twin descriptor over a rendering SUBCLASS of `Node`. */
  decorated(decoration: InlineTokenDecoration<F>): InlineTokenNode<F>;
}

/**
 * Everything an {@link InlineTokenNode} is, minus the brand — the shape the one
 * factory builds before stamping it.
 */
export type UnbrandedInlineTokenNode<F extends TokenFields> = Omit<
  InlineTokenNode<F>,
  typeof INLINE_TOKEN_NODE
>;

/**
 * Stamp a freshly built descriptor as a real one.
 *
 * The ONLY exported way to obtain the brand, and it exists for exactly one
 * caller: `defineInlineTokenNode` in the `node` sub-plugin, which owns the
 * Lexical class and therefore cannot live in this (synchronously loadable)
 * plugin. The symbol itself stays unexported, so the brand is unspellable in an
 * object literal and a fabricated descriptor has to announce itself by calling a
 * function with `brand` in its name.
 */
export function brandInlineTokenNode<F extends TokenFields>(
  descriptor: UnbrandedInlineTokenNode<F>,
): InlineTokenNode<F> {
  return { ...descriptor, [INLINE_TOKEN_NODE]: true };
}
