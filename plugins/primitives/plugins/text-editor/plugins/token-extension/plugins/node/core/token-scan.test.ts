/**
 * The ONE line scan's semantics. These used to be three hand-rolled copies with
 * three different answers; each assertion below is one of the behaviours that
 * had to be reconciled, plus the `code`-mark rule that none of them had.
 *
 * It lives in the `node` sub-plugin rather than beside `token-scan.ts` because
 * it exercises the scan through REAL token families, and a real family can only
 * come from `defineInlineTokenNode` — which is on this side of the sync/async
 * split. The parent must import nothing from here (see its `CLAUDE.md`), so the
 * test moved rather than the factory.
 *
 * Run with `./equin test plugins/primitives/plugins/text-editor/plugins/token-extension`.
 */

import { describe, expect, test } from "bun:test";
import {
  hasToken,
  matchTokens,
  tokenExtension,
} from "@plugins/primitives/plugins/text-editor/plugins/token-extension/core";
import { defineInlineTokenNode } from "./inline-token-node";

const pageLink = tokenExtension({
  id: "page-link",
  pattern: /\[\[page:([^\][\n]+)\]\]/,
  node: defineInlineTokenNode<{ pageId: string }>({
    type: "scan-page-link",
    fields: ["pageId"],
    token: ({ pageId }) => `[[page:${pageId}]]`,
    fieldsOf: (m) => ({ pageId: m[1]! }),
    textContent: "empty",
  }),
});

const math = tokenExtension({
  id: "math",
  pattern: /\\\(([^\n]*?)\\\)/,
  node: defineInlineTokenNode<{ expression: string }>({
    type: "scan-math",
    fields: ["expression"],
    token: ({ expression }) => `\\(${expression}\\)`,
    fieldsOf: (m) => ({ expression: m[1]! }),
    textContent: "empty",
  }),
});

/** A family whose pattern over-matches: only `/api/…` targets are real tokens. */
const image = tokenExtension({
  id: "image",
  // Deliberately /g — a stateful `lastIndex` is exactly what the scan must not
  // inherit between calls.
  pattern: /!\[([^\]]*)\]\(([^)\s]+)\)/g,
  node: defineInlineTokenNode<{ url: string; alt: string }>({
    type: "scan-image",
    fields: ["url", "alt"],
    token: ({ url, alt }) => `![${alt}](${url})`,
    fieldsOf: (m) =>
      m[2]!.startsWith("/api/") ? { url: m[2]!, alt: m[1] ?? "" } : null,
    textContent: "empty",
  }),
});

const ALL = [pageLink, math, image];

describe("matchTokens", () => {
  test("returns tokens in document order across several extensions", () => {
    const text = "a \\(x^2\\) b [[page:p1]] c";
    expect(matchTokens(text, undefined, ALL).map((m) => m.text)).toEqual([
      "\\(x^2\\)",
      "[[page:p1]]",
    ]);
  });

  test("hands back the parsed fields, not just the raw match", () => {
    const [match] = matchTokens("see [[page:p1]]", undefined, ALL);
    expect(match!.fields).toEqual({ pageId: "p1" });
    expect(match!.extension.id).toBe("page-link");
    expect(match!.start).toBe(4);
    expect(match!.end).toBe(15);
  });

  test("a match starting inside an already-taken span is dropped", () => {
    // The math delimiters swallow the page-link token whole; first-by-position
    // wins and the inner candidate never appears.
    const text = "\\( [[page:p1]] \\)";
    const matches = matchTokens(text, undefined, ALL);
    expect(matches.map((m) => m.extension.id)).toEqual(["math"]);
  });

  test("a match whose fields are null is not a token and consumes nothing", () => {
    const text = "![alt](https://example.com/x.png) then [[page:p1]]";
    expect(
      matchTokens(text, undefined, ALL).map((m) => m.extension.id),
    ).toEqual(["page-link"]);
  });

  test("is not stateful across calls for a /g pattern", () => {
    const text = "![a](/api/attachments/1)";
    for (let i = 0; i < 3; i++) {
      expect(matchTokens(text, undefined, ALL)).toHaveLength(1);
    }
  });

  test("no extensions means no tokens", () => {
    expect(matchTokens("[[page:p1]]", undefined, [])).toEqual([]);
  });
});

describe("the code mark", () => {
  test("a `code`-marked run yields NO tokens", () => {
    // `att-…` / `[[page:…]]` written as inline code is documentation. Turning it
    // into a live widget both loses the code styling and asserts a link the
    // author did not write.
    expect(matchTokens("[[page:p1]]", ["code"], ALL)).toEqual([]);
    expect(matchTokens("\\(x\\)", ["bold", "code"], ALL)).toEqual([]);
  });

  test("every other mark leaves the scan alone", () => {
    for (const mark of ["bold", "italic", "underline", "strikethrough"]) {
      expect(matchTokens("[[page:p1]]", [mark], ALL)).toHaveLength(1);
    }
    expect(matchTokens("[[page:p1]]", [], ALL)).toHaveLength(1);
  });
});

describe("hasToken", () => {
  test("detects a token anywhere in the text", () => {
    expect(hasToken("fix [[page:p1]] please", ALL)).toBe(true);
    expect(hasToken("\\(a\\)", ALL)).toBe(true);
  });

  test("leaves ordinary text alone", () => {
    expect(hasToken("just some text", ALL)).toBe(false);
    expect(hasToken("[[page:", ALL)).toBe(false);
    expect(hasToken("anything", [])).toBe(false);
  });

  test("is not stateful across calls for a /g pattern", () => {
    // A shared /g regex would alternate true/false on `lastIndex`.
    const text = "![a](/api/attachments/1)";
    expect(hasToken(text, ALL)).toBe(true);
    expect(hasToken(text, ALL)).toBe(true);
    expect(hasToken(text, ALL)).toBe(true);
  });
});
