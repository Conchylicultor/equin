import { describe, expect, it, vi } from "vitest";
import { declareRenderMode } from "@plugins/primitives/plugins/dom/plugins/render-mode/core/testing";
import { activationProps, linkProps } from "../internal/link-gesture";

// vitest runs each file in its own module registry, so this declaration — once
// per process, by design — reaches no other suite.
declareRenderMode("static");

// A static render (HTML for robots, never hydrated): no click will ever run
// href(), so the destination is written into the markup.
describe("linkProps in a static render", () => {
  it("writes href() as data-link", () => {
    const target = { open: vi.fn(), href: () => "/agents/c/42" };
    expect(linkProps(target)["data-link"]).toBe("/agents/c/42");
  });

  it("keeps data-link through activationProps, isolated or not", () => {
    const target = { open: vi.fn(), href: () => "/pages/p/7" };
    expect(activationProps(target)["data-link"]).toBe("/pages/p/7");
    expect(activationProps(target, { isolate: true })["data-link"]).toBe(
      "/pages/p/7",
    );
  });

  it("a plain action carries no data-link", () => {
    expect(activationProps(() => undefined)).not.toHaveProperty("data-link");
  });

  it("a throwing href() fails the render", () => {
    const target = {
      open: vi.fn(),
      href: () => {
        throw new Error("no destination");
      },
    };
    expect(() => linkProps(target)).toThrow("no destination");
  });
});
