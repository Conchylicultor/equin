/**
 * The synthesized node class's contract. Every assertion here is a load-bearing
 * property of the `@lexical/yjs` binding, not a style preference — see the
 * module header of `inline-token-node.ts` for the citations.
 *
 * Run with `./equin test plugins/primitives/plugins/text-editor/plugins/token-extension`.
 */

import { describe, expect, test } from "bun:test";
import { createEditor, type LexicalEditor, type LexicalNode } from "lexical";
import { defineInlineTokenNode } from "./inline-token-node";

type MentionFields = { id: string; label: string | null };

const mention = defineInlineTokenNode<MentionFields>({
  type: "test-mention",
  fields: ["id", "label"],
  token: ({ id, label }) =>
    label === null ? `[[${id}]]` : `[[${id}|${label}]]`,
  fieldsOf: (m) => ({ id: m[1]!, label: m[2] ?? null }),
  textContent: "token",
});

const MENTION_PATTERN = /\[\[([a-z0-9]+)(?:\|([^\]]+))?\]\]/;

const silent = defineInlineTokenNode<{ value: string }>({
  type: "test-silent",
  fields: ["value"],
  token: ({ value }) => `<${value}>`,
  fieldsOf: (m) => ({ value: m[1]! }),
  textContent: "empty",
});

function editorWith(...nodes: unknown[]): LexicalEditor {
  return createEditor({
    namespace: "token-node-test",
    nodes: nodes as never,
    onError: (e) => {
      throw e;
    },
  });
}

/** Run `fn` inside a discrete update (node construction needs an active editor). */
function inEditor<T>(editor: LexicalEditor, fn: () => T): T {
  let out!: T;
  editor.update(
    () => {
      out = fn();
    },
    { discrete: true },
  );
  return out;
}

describe("zero-arg construction", () => {
  test("seeds every declared field as an own enumerable property", () => {
    const editor = editorWith(mention.Node);
    const own = inEditor(editor, () => {
      const Ctor = mention.Node as unknown as new () => LexicalNode;
      const node = new Ctor();
      return Object.keys(node);
    });
    // `initializeNodeProperties` snapshots exactly this set ONCE per registered
    // class; a field missing here never crosses the CRDT.
    expect(own).toContain("__id");
    expect(own).toContain("__label");
  });

  test("the seeded values are empty strings, not undefined", () => {
    const editor = editorWith(mention.Node);
    const fields = inEditor(editor, () => {
      const Ctor = mention.Node as unknown as new () => LexicalNode;
      return mention.fieldsOfNode(new Ctor());
    });
    expect(fields).toEqual({ id: "", label: "" });
  });
});

describe("clone", () => {
  test("preserves every field AND the node key", () => {
    const editor = editorWith(mention.Node);
    const { same, fields, cloneKey, originalKey } = inEditor(editor, () => {
      const node = mention.create({ id: "abc", label: "Alice" });
      const Klass = mention.Node as unknown as {
        clone(n: LexicalNode): LexicalNode;
      };
      const copy = Klass.clone(node);
      return {
        same: copy === node,
        fields: mention.fieldsOfNode(copy),
        cloneKey: copy.getKey(),
        originalKey: node.getKey(),
      };
    });
    expect(same).toBe(false);
    expect(fields).toEqual({ id: "abc", label: "Alice" });
    expect(cloneKey).toBe(originalKey);
  });

  test("a null field survives the clone as null, not as an empty string", () => {
    const editor = editorWith(mention.Node);
    const fields = inEditor(editor, () => {
      const node = mention.create({ id: "abc", label: null });
      const Klass = mention.Node as unknown as {
        clone(n: LexicalNode): LexicalNode;
      };
      return mention.fieldsOfNode(Klass.clone(node));
    });
    expect(fields).toEqual({ id: "abc", label: null });
  });
});

describe("token / fieldsOf round-trip", () => {
  test("a token spelled from fields reads back as the same fields", () => {
    for (const fields of [
      { id: "abc", label: null },
      { id: "x9", label: "A label" },
    ] satisfies MentionFields[]) {
      const token = mention.tokenOf(fields);
      const match = MENTION_PATTERN.exec(token);
      expect(match).not.toBeNull();
      expect(mention.fieldsOf(match!)).toEqual(fields);
    }
  });

  test("`token(node)` answers only for its own family", () => {
    const editor = editorWith(mention.Node, silent.Node);
    const { own, foreign } = inEditor(editor, () => {
      const node = mention.create({ id: "abc", label: null });
      return {
        own: mention.token(node),
        foreign: silent.token(node),
      };
    });
    expect(own).toBe("[[abc]]");
    expect(foreign).toBeNull();
  });
});

describe("textContent", () => {
  test('"token" answers the serialized token (the clipboard basis)', () => {
    const editor = editorWith(mention.Node);
    const text = inEditor(editor, () =>
      mention.create({ id: "abc", label: "Alice" }).getTextContent(),
    );
    expect(text).toBe("[[abc|Alice]]");
  });

  test('"empty" answers "" (so the token never leaks into root-text scans)', () => {
    const editor = editorWith(silent.Node);
    const text = inEditor(editor, () =>
      silent.create({ value: "hi" }).getTextContent(),
    );
    expect(text).toBe("");
  });
});

describe("JSON", () => {
  test("export → import round-trips every field", () => {
    const editor = editorWith(mention.Node);
    const fields = inEditor(editor, () => {
      const json = mention
        .create({ id: "abc", label: null })
        .exportJSON() as unknown as Record<string, unknown>;
      expect(json.type).toBe("test-mention");
      const Klass = mention.Node as unknown as {
        importJSON(j: Record<string, unknown>): LexicalNode;
      };
      return mention.fieldsOfNode(Klass.importJSON(json));
    });
    expect(fields).toEqual({ id: "abc", label: null });
  });
});

describe("decorated twin", () => {
  const decorated = silent.decorated({
    className: "chip",
    render: ({ value }) => value,
  });

  test("shares the type, the fields and the token format", () => {
    expect(decorated.type).toBe(silent.type);
    expect(decorated.fields).toEqual(silent.fields);
    expect(decorated.tokenOf({ value: "q" })).toBe(
      silent.tokenOf({ value: "q" }),
    );
  });

  test("is a subclass, so each descriptor recognizes the other's nodes", () => {
    const editor = editorWith(decorated.Node);
    const { byBase, byTwin } = inEditor(editor, () => {
      const node = decorated.create({ value: "q" });
      return { byBase: silent.is(node), byTwin: decorated.is(node) };
    });
    expect(byBase).toBe(true);
    expect(byTwin).toBe(true);
  });

  test("the HEADLESS class refuses to build DOM rather than building a wrong one", () => {
    const editor = editorWith(silent.Node);
    expect(() =>
      inEditor(editor, () => {
        const node = silent.create({ value: "q" }) as unknown as {
          createDOM(): HTMLElement;
        };
        return node.createDOM();
      }),
    ).toThrow(/createDOM/);
  });
});

describe("setFields", () => {
  test("overwrites only the named fields", () => {
    const editor = editorWith(mention.Node);
    const fields = inEditor(editor, () => {
      const node = mention.create({ id: "abc", label: "Alice" });
      mention.setFields(node, { label: null });
      return mention.fieldsOfNode(node);
    });
    expect(fields).toEqual({ id: "abc", label: null });
  });
});
