import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { parseSavedSymbolName } from "@plugins/ui/plugins/icons/plugins/saved-names/core";
import { Avatar } from "../components/avatar";
import { avatarColorPick } from "../../core";
import { avatarFlatClass } from "../internal/colors";
import {
  AvatarPresentationProvider,
  useAvatarPresentation,
} from "../internal/presentation";

afterEach(cleanup);

const face = parseSavedSymbolName("face");

function box(container: HTMLElement): HTMLElement {
  const el = container.firstElementChild;
  if (!(el instanceof HTMLElement)) throw new Error("no avatar box rendered");
  return el;
}

// jsdom evaluates no stylesheet, so these pin the class contract.
describe("Avatar badge (default presentation)", () => {
  it("renders today's density-ramp disc with the soft paint", () => {
    const { container } = render(<Avatar color="rose" icon={face} />);
    expect(box(container).className).toBe(
      "relative inline-flex shrink-0 items-center justify-center @container-[size] rounded-full size-8 bg-categorical-4/15 text-categorical-4",
    );
  });

  it("sizes a fallback letter as the md disc's share of its box", () => {
    const { container } = render(
      <Avatar fallbackKey="mail" fallbackGlyph="m" />,
    );
    const letter = box(container).querySelector("span");
    expect(letter?.textContent).toBe("M");
    expect(letter?.classList).toContain("text-[length:43.75cqh]");
  });

  it("keeps the ringed status dot", () => {
    const { container } = render(<Avatar statusDot="bg-success" />);
    const dot = box(container).querySelector("[aria-hidden]");
    expect(dot?.className).toBe(
      "absolute rounded-full ring-background size-2.5 -right-0.5 -bottom-0.5 ring-2 bg-success",
    );
  });

  it("draws a squircle outline when asked", () => {
    const { container } = render(<Avatar shape="squircle" color="sky" />);
    expect(box(container).classList).toContain("rounded-squircle");
    expect(box(container).classList).not.toContain("rounded-full");
  });

  it("defaults the presentation to badge outside any provider", () => {
    let seen: string | null = null;
    function Probe() {
      seen = useAvatarPresentation();
      return null;
    }
    render(<Probe />);
    expect(seen).toBe("badge");
  });
});

describe("Avatar tile presentation", () => {
  function renderTile(node: ReactNode) {
    return render(
      <AvatarPresentationProvider value="tile">
        {node}
      </AvatarPresentationProvider>,
    );
  }

  it("fills its parent with the flat paint and a 46% glyph", () => {
    const { container } = renderTile(
      <Avatar fallbackKey="home" icon={face} shape="squircle" />,
    );
    const el = box(container);
    expect(el.classList).toContain("size-full");
    expect(el.classList).toContain("rounded-squircle");
    expect(el.classList).not.toContain("size-8");
    for (const cls of avatarFlatClass(avatarColorPick(null, "home")).split(
      " ",
    )) {
      expect(el.classList).toContain(cls);
    }
    expect(el.querySelector("svg")?.getAttribute("class")).toContain(
      "size-[46%]",
    );
  });

  it("sizes a fallback letter to 46% of the box", () => {
    const { container } = renderTile(
      <Avatar fallbackKey="mail" fallbackGlyph="m" />,
    );
    const letter = box(container).querySelector("span");
    expect(letter?.textContent).toBe("M");
    expect(letter?.classList).toContain("text-[length:46cqh]");
  });

  it("draws the status dot without a ring", () => {
    const { container } = renderTile(<Avatar statusDot="bg-success" />);
    const dot = box(container).querySelector("[aria-hidden]");
    expect(dot).not.toBeNull();
    expect(dot?.className).not.toMatch(/\bring-\d/);
  });
});

describe("Avatar fill (a colour outside the categorical palette)", () => {
  it("paints the tile with the fill and wins over color", () => {
    const { container } = render(
      <AvatarPresentationProvider value="tile">
        <Avatar fill="var(--place-food)" color="rose" icon={face} />
      </AvatarPresentationProvider>,
    );
    const el = box(container);
    expect(el.style.getPropertyValue("--avatar-fill")).toBe(
      "var(--place-food)",
    );
    expect(el.classList).toContain("bg-[var(--avatar-fill)]");
    expect(el.classList).not.toContain("bg-categorical-4");
  });

  it("paints the badge with a soft tint of the fill", () => {
    const { container } = render(<Avatar fill="#06ACC1" icon={face} />);
    expect(box(container).classList).toContain("text-[var(--avatar-fill)]");
  });

  it("colorless still wins", () => {
    const { container } = render(
      <Avatar fill="#06ACC1" colorless icon={face} />,
    );
    const el = box(container);
    expect(el.style.getPropertyValue("--avatar-fill")).toBe("");
    expect(el.classList).toContain("bg-muted");
  });
});
