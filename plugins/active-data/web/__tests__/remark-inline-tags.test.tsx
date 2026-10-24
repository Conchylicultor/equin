import { describe, expect, test } from "vitest";
import { render } from "@testing-library/react";
import ReactMarkdown, { type Components } from "react-markdown";
import type { ReactNode } from "react";
import {
  INLINE_TAG_ELEMENT,
  remarkInlineTags,
} from "../internal/remark-inline-tags";

function Probe(props: {
  children?: ReactNode;
  "data-tag": string;
  "data-content": string;
  "data-attrs": string;
}) {
  return (
    <mark
      data-tag={props["data-tag"]}
      data-content={props["data-content"]}
      data-attrs={props["data-attrs"]}
    >
      {props.children}
    </mark>
  );
}

const components = { [INLINE_TAG_ELEMENT]: Probe } as Partial<Components>;

function md(source: string) {
  return render(
    <ReactMarkdown
      remarkPlugins={remarkInlineTags(["go"])}
      components={components}
    >
      {source}
    </ReactMarkdown>,
  ).container;
}

describe("remarkInlineTags", () => {
  test("pairs an inline tag inside its paragraph, keeping the markdown between", () => {
    const root = md('Done. <go x="1">Push **it**</go> now.');
    const p = root.querySelector("p")!;
    const mark = p.querySelector("mark")!;
    expect(mark.dataset.tag).toBe("go");
    expect(mark.dataset.content).toBe("Push **it**");
    expect(JSON.parse(mark.dataset.attrs!)).toEqual({ x: "1" });
    expect(mark.querySelector("strong")!.textContent).toBe("it");
    expect(p.textContent).toBe("Done. Push it now.");
  });

  test("a quoted attribute value may hold `>`", () => {
    const root = md('See <go path="a > b" element="button — Share">it</go>.');
    const mark = root.querySelector("mark")!;
    expect(JSON.parse(mark.dataset.attrs!)).toEqual({
      path: "a > b",
      element: "button — Share",
    });
    expect(mark.textContent).toBe("it");
  });

  test("pairs inside a list item", () => {
    const root = md("- a <go>b</go>");
    expect(root.querySelector("li mark")!.textContent).toBe("b");
  });

  test("leaves an unknown tag and an unclosed one alone", () => {
    const root = md("x <task>y</task> and <go>z");
    expect(root.querySelector("mark")).toBeNull();
  });
});
