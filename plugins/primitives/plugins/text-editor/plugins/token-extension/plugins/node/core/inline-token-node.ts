import {
  DecoratorNode,
  type DOMConversionMap,
  type DOMConversionOutput,
  type DOMExportOutput,
  type EditorConfig,
  type Klass,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
} from "lexical";
import type { ReactNode } from "react";
import {
  brandInlineTokenNode,
  type InlineTokenDecoration,
  type InlineTokenNode,
  type InlineTokenNodeSpec,
  type TokenFields,
  type TokenFieldValue,
} from "@plugins/primitives/plugins/text-editor/plugins/token-extension/core";
import { tokenDomElement, tokenDomFields } from "./token-dom";

/**
 * The Lexical class factory behind an inline token family.
 *
 * This module is the reason the `node` sub-plugin exists: `DecoratorNode` is a
 * VALUE, and one runtime edge to `lexical` makes a module graph
 * asynchronously-loadable-only. The parent plugin's barrel is reachable from
 * `@plugins/page/plugins/editor/server`, which drizzle-kit `require()`s
 * synchronously during migration generation — so the declaration TYPES live up
 * there and the class lives here. See the parent's `CLAUDE.md`.
 *
 * The design itself — why `fields` is a list of names, why there are two
 * descriptor types, why the headless class and its decorated twin share one
 * hierarchy — is documented on the types, in
 * `token-extension/core/inline-token-types.ts`.
 */

type MutableNode = LexicalNode & Record<string, unknown>;

/**
 * Declare an inline token family and derive its headless Lexical node class.
 *
 * @see `inline-token-types.ts`'s module header for why the constructor takes no
 * fields and why `fields` is a list of names.
 */
export function defineInlineTokenNode<F extends TokenFields>(
  spec: InlineTokenNodeSpec<F>,
): InlineTokenNode<F> {
  const { type, fields, textContent } = spec;
  const props = fields.map((f) => `__${f}`);

  // The three property walks, stated once each. Every one takes its node as a
  // plain `LexicalNode`: that is the type the `MutableNode` view is reachable
  // from, so a caller holding a subclass instance passes it in rather than
  // widening at the cast.
  const readFields = (node: LexicalNode): F => {
    const out: Record<string, TokenFieldValue> = {};
    for (let i = 0; i < fields.length; i++) {
      out[fields[i]!] = (node as MutableNode)[props[i]!] as TokenFieldValue;
    }
    return out as F;
  };

  /** Seed every `__<field>` from a record keyed by FIELD name. */
  const writeFields = (
    node: LexicalNode,
    values: Record<string, unknown>,
  ): void => {
    for (let i = 0; i < fields.length; i++) {
      (node as MutableNode)[props[i]!] = (values[fields[i]!] ??
        null) as TokenFieldValue;
    }
  };

  /** Copy every `__<field>` property from one instance onto another. */
  const copyFields = (from: LexicalNode, to: LexicalNode): void => {
    for (const prop of props) {
      (to as MutableNode)[prop] = (from as MutableNode)[prop];
    }
  };

  class InlineTokenBase extends DecoratorNode<ReactNode> {
    constructor(key?: NodeKey) {
      super(key);
      // Zero-arg construction MUST leave every field an own enumerable
      // property: `@lexical/yjs`'s `initializeNodeProperties` does `new klass()`
      // exactly once per registered class and snapshots `Object.entries(node)`
      // as the property set it will ever sync. A field seeded lazily is a field
      // that silently never crosses the CRDT.
      for (const prop of props) (this as MutableNode)[prop] = "";
    }

    static getType(): string {
      return type;
    }

    static clone(node: InlineTokenBase): InlineTokenBase {
      const Ctor = node.constructor as new (key?: NodeKey) => InlineTokenBase;
      const copy = new Ctor(node.__key);
      copyFields(node, copy);
      return copy;
    }

    static importJSON(json: Record<string, unknown>): InlineTokenBase {
      const Ctor = this as unknown as new () => InlineTokenBase;
      const node = new Ctor();
      writeFields(node, json);
      return node;
    }

    exportJSON(): SerializedLexicalNode {
      // Typed as what Lexical declares, not as a loose record. An override that
      // narrows `exportJSON`'s return to `Record<string, unknown>` drops `type`
      // and `version` from the class's type, and that alone makes the whole
      // class structurally unrelated to `LexicalNode` — which is what made
      // `this` unusable wherever a `LexicalNode` was expected.
      const json: SerializedLexicalNode & Record<string, unknown> = {
        type,
        version: 1,
      };
      // Written through the record half: keyed by `keyof F & string`, the
      // intersection's element type would resolve against the serialized shape.
      const out: Record<string, unknown> = json;
      const values: Record<string, TokenFieldValue> = readFields(this);
      for (const field of fields) out[field] = values[field];
      return json;
    }

    /**
     * The token's HTML flavour — see `./token-dom.ts` for the encoding and for
     * why an inline token needs one at all.
     *
     * Derived from the same declaration `getTextContent` and the serializer are
     * (`type`, `fields`, `token`), so there is no way to declare a family whose
     * HTML export is empty: the default — `createDOM()`, the decorator's empty
     * React host — is exactly the shape that made a cross-block chip paste as a
     * blank, and it is no longer reachable.
     */
    exportDOM(_editor: LexicalEditor): DOMExportOutput {
      const values = readFields(this);
      return { element: tokenDomElement(type, values, spec.token(values)) };
    }

    /**
     * Rebuild one of this family's nodes from {@link exportDOM}'s element.
     *
     * `this` is the REGISTERED class — the decorated twin in a browser editor,
     * the headless base in a server one — so a rebuilt node is the same class
     * every other node in that editor is, without this factory having to know
     * which twin it minted.
     */
    static importDOM(): DOMConversionMap | null {
      const Ctor = this as unknown as new () => LexicalNode;
      return {
        span: (element: HTMLElement) => {
          const values = tokenDomFields(element, type, fields);
          if (values === null) return null;
          return {
            conversion: (): DOMConversionOutput => {
              const node = new Ctor();
              writeFields(node, values);
              return { node };
            },
            // Above `TextNode`'s own `span` conversion, which is priority 0 and
            // would otherwise claim the host element as a Google-Docs wrapper
            // and reduce it to its text.
            priority: 4,
          };
        },
      };
    }

    isInline(): true {
      return true;
    }

    getTextContent(): string {
      return textContent === "token" ? spec.token(readFields(this)) : "";
    }

    // These three keep Lexical's own parameter lists even though nothing here
    // reads them. A shorter override is legal for ordinary assignability but
    // not for the COMPARABLE relation the `as` casts below are checked against,
    // and an arity mismatch there reads as "these two types don't overlap".
    createDOM(_config: EditorConfig, _editor: LexicalEditor): HTMLElement {
      throw new Error(
        `${type}: createDOM() on the HEADLESS token node. A browser editor must ` +
          `register the class from \`.decorated({ render })\`, not this one.`,
      );
    }

    updateDOM(
      _prevNode: unknown,
      _dom: HTMLElement,
      _config: EditorConfig,
    ): false {
      return false;
    }

    decorate(_editor: LexicalEditor, _config: EditorConfig): ReactNode {
      return null;
    }
  }

  const descriptorFor = (Node: Klass<LexicalNode>): InlineTokenNode<F> => {
    const create = (values: F): LexicalNode => {
      const Ctor = Node as unknown as new () => LexicalNode;
      const node = new Ctor();
      writeFields(node, values);
      return node;
    };
    const is = (node: LexicalNode | null | undefined): boolean =>
      node != null && node.getType() === type;

    return brandInlineTokenNode<F>({
      type,
      fields,
      textContent,
      Node,
      create,
      is,
      fieldsOfNode: readFields,
      setFields(node: LexicalNode, patch: Partial<F>): void {
        const writable = node.getWritable() as MutableNode;
        for (const [key, value] of Object.entries(patch)) {
          writable[`__${key}`] = value;
        }
      },
      token(node: LexicalNode): string | null {
        return is(node) ? spec.token(readFields(node)) : null;
      },
      tokenOf: spec.token,
      fieldsOf: spec.fieldsOf,
      createFromMatch(match: RegExpExecArray): LexicalNode | null {
        const values = spec.fieldsOf(match);
        return values === null ? null : create(values);
      },
      decorated(decoration: InlineTokenDecoration<F>): InlineTokenNode<F> {
        class DecoratedTokenNode extends (Node as unknown as typeof InlineTokenBase) {
          // Lexical validates that a registered class OWNS these three statics —
          // it reads them off the class, not the prototype chain, so an inheriting
          // subclass trips "must implement static getType/clone" at registration.
          // The base implementations are already polymorphic (`clone` builds from
          // `node.constructor`, `importJSON` from `this`), so these delegate rather
          // than reimplement: the decorated twin is the SAME token type, and must
          // stay so — `is()` answers by type, and the seed/projection pair depends
          // on a decorated node serializing exactly like its headless base.
          static getType(): string {
            return type;
          }

          static clone(node: InlineTokenBase): InlineTokenBase {
            return (Node as unknown as typeof InlineTokenBase).clone(node);
          }

          static importJSON(json: Record<string, unknown>): InlineTokenBase {
            return (Node as unknown as typeof InlineTokenBase).importJSON.call(
              this,
              json,
            );
          }

          createDOM(
            _config: EditorConfig,
            _editor: LexicalEditor,
          ): HTMLElement {
            const span = document.createElement("span");
            // `max-w-full`: the host is bounded by its line, so a token wider
            // than the editor (a long conversation chip) gets constrained and
            // its own truncating label ellipsizes. An `inline-flex` host
            // without it sizes to its content's max-content width, and the
            // chip inside is clipped by the editor instead.
            span.className = ["max-w-full", decoration.className]
              .filter(Boolean)
              .join(" ");
            return span;
          }

          decorate(_editor: LexicalEditor, _config: EditorConfig): ReactNode {
            return decoration.render(readFields(this), this);
          }
        }
        return descriptorFor(
          DecoratedTokenNode as unknown as Klass<LexicalNode>,
        );
      },
    });
  };

  return descriptorFor(InlineTokenBase as unknown as Klass<LexicalNode>);
}
