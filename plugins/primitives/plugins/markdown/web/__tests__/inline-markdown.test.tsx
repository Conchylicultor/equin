import type React from "react";
import { describe, expect, test } from "vitest";
import { render } from "@testing-library/react";
import { renderWithTransport } from "@plugins/primitives/plugins/networking/web/testing";
import { MarkdownRenderer } from "../internal/markdown-renderer";
import { MarkdownEnhancementContext } from "../internal/enhancement-context";

function inline(source: string) {
  return render(<MarkdownRenderer inline>{source}</MarkdownRenderer>).container;
}

describe("inline markdown", () => {
  test.each([
    "1. Free slots on settle",
    "- a bullet",
    "# a heading",
    "> a quote",
    "---",
  ])("text that starts like a block stays its words: %s", (source) => {
    const el = inline(source);
    expect(el.textContent).toBe(source);
    expect(el.querySelector("ol, ul, li, h1, blockquote, hr, p")).toBeNull();
  });

  test("inline syntax still renders", () => {
    const el = inline("1. **bold** and `code`");
    expect(el.querySelector("strong")?.textContent).toBe("bold");
    expect(el.querySelector("code")?.textContent).toBe("code");
    expect(el.querySelector("ol")).toBeNull();
  });

  test("an inline render runs the enhancers' transforms on its words", () => {
    const chip = (children: React.ReactNode) =>
      typeof children === "string" && children.includes("task-1") ? (
        <span data-chip>{children}</span>
      ) : (
        children
      );
    const el = render(
      <MarkdownEnhancementContext.Provider
        value={{
          transforms: [chip],
          components: {},
          inlineCodeHandlers: [],
          remarkPlugins: [],
        }}
      >
        <MarkdownRenderer inline>{"start task-1"}</MarkdownRenderer>
      </MarkdownEnhancementContext.Provider>,
    ).container;
    expect(el.querySelector("[data-chip]")?.textContent).toBe("start task-1");
    expect(el.querySelector("p")).toBeNull();
  });

  test("a block render keeps its lists", () => {
    const el = render(
      <MarkdownRenderer>{"1. one"}</MarkdownRenderer>,
    ).container;
    expect(el.querySelector("ol")).not.toBeNull();
  });
});

describe("bare file paths are literal", () => {
  function block(source: string) {
    return renderWithTransport(<MarkdownRenderer>{source}</MarkdownRenderer>)
      .container;
  }

  test.each([
    "Read /srv/__A__/dev/x.md first",
    "see plugins/foo/__init__.py",
    "home ~/__A__/x.md here",
    "a /tmp/~~x~~/y.md path",
  ])("no emphasis inside a path: %s", (source) => {
    const el = block(source);
    expect(el.querySelector("strong, em, del")).toBeNull();
    expect(el.textContent).toBe(source);
  });

  test("the path stays one text node", () => {
    const el = block("Read /srv/__A__/dev/x.md (sections)");
    expect(el.querySelector("p")?.childNodes).toHaveLength(1);
  });

  test("emphasis around a path still renders", () => {
    expect(block("_/a/b.md_").querySelector("em")?.textContent).toBe("/a/b.md");
    expect(block("__/a/b.md__").querySelector("strong")?.textContent).toBe(
      "/a/b.md",
    );
    expect(block("**/a/b.md**").querySelector("strong")?.textContent).toBe(
      "/a/b.md",
    );
  });

  test("emphasis next to a slash outside a path still renders", () => {
    const el = block("this and/or __that__ / __bold__");
    expect(
      [...el.querySelectorAll("strong")].map((s) => s.textContent),
    ).toEqual(["that", "bold"]);
  });

  test("links and URLs are unaffected", () => {
    const el = block("[/a/__b__](/x/__y__) https://a.com/__x__/");
    expect(el.querySelector("a")?.getAttribute("href")).toBe("/x/__y__");
    expect(el.querySelector("a")?.textContent).toBe("/a/__b__");
    expect(el.querySelector("strong")).toBeNull();
  });
});
