import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Inline } from "../index";

afterEach(cleanup);

describe("Inline", () => {
  it("renders an inline-level (not block-level) flex row by default", () => {
    render(
      <Inline gap="2xs" data-testid="box">
        <span>child</span>
      </Inline>,
    );
    const el = document.querySelector<HTMLElement>('[data-testid="box"]')!;
    // Default host element is a span (inline element), not a div.
    expect(el.tagName).toBe("SPAN");
    // inline-flex wins over Stack's block-level `flex` (tailwind-merge display group).
    expect(el.classList.contains("inline-flex")).toBe(true);
    expect(el.classList.contains("flex")).toBe(false);
    expect(el.classList.contains("flex-row")).toBe(true);
    // align-baseline seats the box on the surrounding text baseline.
    expect(el.classList.contains("align-baseline")).toBe(true);
    // gap drawn from the spacing ramp.
    expect(el.classList.contains("gap-2xs")).toBe(true);
    // default cross-axis alignment is center.
    expect(el.classList.contains("items-center")).toBe(true);
    // bounded by its line, so a long label inside truncates instead of overflowing.
    expect(el.classList.contains("max-w-full")).toBe(true);
  });

  it("never bakes in min-w-0 — the truncation leaf owns it, not the container", () => {
    render(
      <Inline gap="none" className="max-w-xs" data-testid="box">
        <span>x</span>
      </Inline>,
    );
    const el = document.querySelector<HTMLElement>('[data-testid="box"]')!;
    expect(el.classList.contains("min-w-0")).toBe(false);
    // caller className composes last: its own bound replaces the default one.
    expect(el.classList.contains("max-w-xs")).toBe(true);
    expect(el.classList.contains("max-w-full")).toBe(false);
  });

  it("honors as / align overrides and forwards arbitrary attributes", () => {
    render(
      <Inline gap="sm" as="div" align="start" title="t" data-testid="box">
        <span>x</span>
      </Inline>,
    );
    const el = document.querySelector<HTMLElement>('[data-testid="box"]')!;
    expect(el.tagName).toBe("DIV");
    expect(el.classList.contains("items-start")).toBe(true);
    expect(el.getAttribute("title")).toBe("t");
  });
});
