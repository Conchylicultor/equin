import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { RolePart } from "../../core";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const PART: RolePart = {
  role: "--card-title-role",
  emphasis: "--card-title-emphasis",
  family: "--card-title-family",
  fallback: "label",
};

/** `<Text pick>` as an engine whose `CSS.supports` answers `hasIf` for `if()`. */
async function renderPick(hasIf: boolean): Promise<HTMLElement> {
  vi.stubGlobal("CSS", { supports: () => hasIf });
  const { Text } = await import("../index");
  render(
    <div data-testid="host">
      <Text pick={PART} data-testid="t" style={{ color: "red" }}>
        Title
      </Text>
    </div>,
  );
  return document.querySelector<HTMLElement>('[data-testid="t"]')!;
}

// Where a pick's scope sits depends on the engine: `if()` reads the element's
// own vars (scope on the leaf, no wrapper); the style-query fallback of an
// engine without it reads the PARENT's (scope on a box-less wrapper).
describe("<Text pick> scope placement", () => {
  it("puts the scope on the leaf itself where CSS if() exists", async () => {
    const el = await renderPick(true);
    expect(el.parentElement!.dataset.testid).toBe("host");
    expect(el.style.getPropertyValue("--role-pick")).toBe(
      "var(--card-title-role, label)",
    );
    // The caller's own style still lands.
    expect(el.style.color).toBe("red");
    expect(el.classList.contains("role-pick")).toBe(true);
  });

  it("wraps the leaf in a box-less scope where CSS if() is missing", async () => {
    const el = await renderPick(false);
    const wrapper = el.parentElement!;
    expect(wrapper.dataset.testid).toBeUndefined();
    expect(wrapper.className).toBe("contents");
    expect(wrapper.style.getPropertyValue("--role-pick")).toBe(
      "var(--card-title-role, label)",
    );
    expect(el.style.getPropertyValue("--role-pick")).toBe("");
    expect(el.style.color).toBe("red");
    expect(el.classList.contains("role-pick")).toBe(true);
  });
});
