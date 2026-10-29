import { describe, expect, test } from "vitest";
import { render } from "@testing-library/react";
import { MarkdownRenderer } from "../internal/markdown-renderer";

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

  test("a block render keeps its lists", () => {
    const el = render(
      <MarkdownRenderer>{"1. one"}</MarkdownRenderer>,
    ).container;
    expect(el.querySelector("ol")).not.toBeNull();
  });
});
