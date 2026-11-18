import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { RichText } from "@plugins/page/plugins/editor/core";
// Side-effect import: registering `page/inline-date` is what puts the date family
// in the block-text registry this renderer reads. It is the SUBJECT of the token
// tests below, not a fixture — see them for why.
import "@plugins/page/plugins/inline-date/web";
import { RunsRenderer } from "@plugins/page/plugins/editor/web";

// Focused unit pin for the faithful runs → React mapping: the mark / color /
// link / soft-break behavior, plus the registry-driven token split.
//
// Page-link and inline-math tokens are exercised only through the live app (they
// need pagesTree / KaTeX). The date family stands in for all of them here —
// it needs no provider, and it is the one whose absence was a live bug.

afterEach(cleanup);

/** A date mention on a fixed instant, and the token that spells it. */
const DATE_ISO = "2026-06-17T09:00:00.000Z";
const DATE_TOKEN = `[[date:${DATE_ISO}]]`;

describe("RunsRenderer", () => {
  it("maps bold → <strong> and italic → <em>", () => {
    const runs: RichText = [{ text: "hi", marks: ["bold", "italic"] }];
    const { container } = render(<RunsRenderer value={runs} />);
    const strong = container.querySelector("strong");
    expect(strong).not.toBeNull();
    // italic nests inside bold (bold applied last / outermost).
    expect(strong!.querySelector("em")?.textContent).toBe("hi");
  });

  it("applies underline / strikethrough / code as classes", () => {
    const runs: RichText = [
      { text: "x", marks: ["underline", "strikethrough", "code"] },
    ];
    const { container } = render(<RunsRenderer value={runs} />);
    const span = container.querySelector("span");
    expect(span?.className).toContain("underline");
    expect(span?.className).toContain("line-through");
    expect(span?.className).toContain("font-mono");
  });

  it("renders a color run via the shared --rt-color-* var", () => {
    const runs: RichText = [{ text: "c", color: "blue" }];
    const { container } = render(<RunsRenderer value={runs} />);
    const span = container.querySelector("span");
    expect(span?.getAttribute("style")).toContain("var(--rt-color-blue)");
  });

  it("renders a link run as a non-editable anchor", () => {
    const runs: RichText = [{ text: "go", link: "https://example.com" }];
    const { container } = render(<RunsRenderer value={runs} />);
    const a = container.querySelector("a");
    expect(a?.getAttribute("href")).toBe("https://example.com");
    expect(a?.textContent).toBe("go");
  });

  it("coerces a legacy plain string and preserves soft breaks", () => {
    const { container } = render(<RunsRenderer value={"a\nb"} />);
    expect(container.querySelector("br")).not.toBeNull();
    expect(container.textContent).toBe("ab");
  });

  it("renders an unstyled run as bare text (no wrapper span)", () => {
    const runs: RichText = [{ text: "plain" }];
    const { container } = render(<RunsRenderer value={runs} />);
    expect(container.querySelector("span")).toBeNull();
    expect(container.textContent).toBe("plain");
  });

  // The bug this stage fixes. `RunsRenderer` used to hardcode exactly two token
  // types and race their two regexes, so `[[date:…]]` — which shipped later —
  // rendered as those literal characters on EVERY read-only surface: page
  // history, version diffs, the public site. Nothing failed and nothing could
  // say so. The renderer now walks the same registry the editor does, so there
  // is no per-type case here to forget.
  it("renders a registered [[date:…]] token as a chip, not literal brackets", () => {
    const runs: RichText = [{ text: `due ${DATE_TOKEN} ok` }];
    const { container } = render(<RunsRenderer value={runs} />);

    expect(container.textContent).not.toContain("[[date:");
    expect(container.textContent).not.toContain("]]");
    // The chip is the same `LinkChip` the editor's decorator renders.
    const chip = container.querySelector("button");
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain("Jun 17");
    // The prose either side of the token survives intact.
    expect(container.textContent).toContain("due ");
    expect(container.textContent).toContain(" ok");
  });

  it("leaves a token no registered family claims as plain text", () => {
    const runs: RichText = [{ text: "see [[unregistered:zzz]] here" }];
    const { container } = render(<RunsRenderer value={runs} />);
    expect(container.textContent).toBe("see [[unregistered:zzz]] here");
    expect(container.querySelector("button")).toBeNull();
  });

  it("never chips a run carrying the code mark", () => {
    // Writing a token as inline code is how a person DOCUMENTS one. Turning it
    // into a live widget both loses the code styling and asserts something the
    // author did not write. The rule lives in the shared `matchTokens`, so the
    // editor seed and this renderer cannot disagree about it.
    const runs: RichText = [{ text: DATE_TOKEN, marks: ["code"] }];
    const { container } = render(<RunsRenderer value={runs} />);
    expect(container.textContent).toBe(DATE_TOKEN);
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("span")?.className).toContain("font-mono");
  });
});
