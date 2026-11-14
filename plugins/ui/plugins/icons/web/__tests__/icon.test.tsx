import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import {
  brand,
  runtimeSymbol,
  seti,
  symbol,
  type SavedSymbolName,
} from "../../core/icon-ref";
import type { IconRef } from "../../core/icon-ref";
import type { IconStyle } from "../../core/style";
import { defineIconFamily } from "../../core/icon-family";
import { LUCIDE_FAMILY } from "../../core/lucide-map";
import { provideIconFamilies } from "../internal/family-store";
import { Icon } from "../internal/icon";
import { IconScopeProvider } from "../internal/icon-scope";
import { usePublishIconStyle } from "../internal/style-store";
import { provideSprite, useWantedSprites } from "../internal/sprite-store";
import { pageRuntimeSymbols } from "../internal/runtime-symbol-store";
import { glyphId, type GlyphKey } from "../../core/style";

/**
 * Which symbol `<Icon>` points at: its scope's style (else the root's, else
 * the default), the active fill when `active`, the default style's glyph for
 * as long as the wanted style's has not loaded — every Material and Lucide
 * glyph from the page's glyph store, wanted one by one.
 */

afterEach(cleanup);

/** A sprite holding `<symbol id>` for each of `ids`. */
function spriteOf(...ids: string[]): string {
  return `<svg>${ids.map((id) => `<symbol id="${id}" viewBox="0 0 24 24"></symbol>`).join("")}</svg>`;
}

let chunks = 0;

/** Glyphs `names` of `key` land in the page's store, as a batch would. */
function provideGlyphs(key: GlyphKey, ...names: string[]): void {
  act(() =>
    pageRuntimeSymbols.provide(
      `test-${chunks++}`,
      spriteOf(...names.map((n) => glyphId(key, n))),
      names.map((name) => ({ key, name })),
    ),
  );
}

const forum = symbol("forum");

function hrefOf(container: HTMLElement): string | null {
  return container.querySelector("use")?.getAttribute("href") ?? null;
}

function Publish({
  scope,
  style,
}: {
  scope: string | undefined;
  style: IconStyle;
}) {
  usePublishIconStyle(scope, style);
  return null;
}

const rounded: IconStyle = {
  family: "material",
  shape: "rounded",
  fill: "filled",
  activeFill: "outline",
  weight: "light",
};

describe("<Icon>", () => {
  it("asks for its glyph and draws an empty box until it lands — then the default style: outline at rest, filled when active", () => {
    const rest = render(<Icon icon={forum} />).container;
    const active = render(<Icon icon={forum} active />).container;
    expect(hrefOf(rest)).toBeNull();
    expect(pageRuntimeSymbols.pendingCount()).toBeGreaterThanOrEqual(2);
    provideGlyphs("default-outline-400", "forum");
    provideGlyphs("default-filled-400", "forum");
    expect(hrefOf(rest)).toBe("#msr-default-outline-400-forum");
    expect(hrefOf(active)).toBe("#msr-default-filled-400-forum");
  });

  it("draws the missing-glyph marker for a glyph its batch did not carry", () => {
    const { container } = render(<Icon icon={symbol("grain")} active />);
    act(() =>
      pageRuntimeSymbols.provide("test-empty", "<svg></svg>", [
        { key: "default-filled-400", name: "grain" },
      ]),
    );
    expect(hrefOf(container)).toBeNull();
    expect(container.querySelector("svg g")).not.toBeNull();
  });

  it("is a 1em svg, hidden from assistive tech unless named", () => {
    const { container } = render(<Icon icon={forum} className="size-4" />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("1em");
    expect(svg.getAttribute("class")).toBe("size-4");
    expect(svg.getAttribute("aria-hidden")).toBe("true");

    const named = render(<Icon icon={forum} title="Conversations" />).container;
    const namedSvg = named.querySelector("svg")!;
    expect(namedSvg.getAttribute("aria-hidden")).toBeNull();
    expect(namedSvg.getAttribute("role")).toBe("img");
    expect(named.querySelector("title")?.textContent).toBe("Conversations");
  });

  it("draws a brand from the brands sprite, whatever the style", () => {
    expect(
      hrefOf(render(<Icon icon={brand("github")} active />).container),
    ).toBe("#si-github");
  });

  it("draws its scope's style once that sprite has loaded, the default style until then", () => {
    const { container } = render(
      <>
        <Publish scope="app:notes" style={rounded} />
        <IconScopeProvider scope="app:notes">
          <Icon icon={forum} />
        </IconScopeProvider>
      </>,
    );
    // The scope wants rounded-filled-300, which is not loaded yet.
    expect(hrefOf(container)).toBe("#msr-default-outline-400-forum");
    provideGlyphs("rounded-filled-300", "forum");
    expect(hrefOf(container)).toBe("#msr-rounded-filled-300-forum");
  });

  it("falls back to the root's style for a scope that publishes none", () => {
    provideGlyphs("rounded-outline-300", "forum");
    const { container } = render(
      <>
        <Publish scope={undefined} style={rounded} />
        <IconScopeProvider scope="app:other">
          <Icon icon={forum} active />
        </IconScopeProvider>
      </>,
    );
    expect(hrefOf(container)).toBe("#msr-rounded-outline-300-forum");
  });

  it("refuses a second publisher for one scope", () => {
    expect(() =>
      render(
        <>
          <Publish scope="app:dup" style={rounded} />
          <Publish scope="app:dup" style={rounded} />
        </>,
      ),
    ).toThrow(/two publishers/);
  });
});

describe("<Icon> on a Seti file-type glyph", () => {
  function Wanted() {
    return <span data-testid="wanted">{useWantedSprites().join(",")}</span>;
  }

  it("asks for the Seti sprite on mount and draws an empty box until it lands, whatever the style", () => {
    const { container, getByTestId } = render(
      <>
        <Wanted />
        <Publish scope="app:files" style={rounded} />
        <IconScopeProvider scope="app:files">
          <Icon icon={seti("typescript")} active className="size-4" />
        </IconScopeProvider>
      </>,
    );
    expect(getByTestId("wanted").textContent).toBe("seti");
    expect(container.querySelector("svg")?.getAttribute("class")).toBe(
      "size-4",
    );
    expect(hrefOf(container)).toBeNull();
    act(() => provideSprite("seti", spriteOf("seti-typescript")));
    expect(hrefOf(container)).toBe("#seti-typescript");
  });
});

describe("<Icon> on a runtime (saved) symbol", () => {
  const home = runtimeSymbol("home" as SavedSymbolName);

  it("draws nothing until some style's symbol is held — a loading box, not a wrong glyph", () => {
    const { container } = render(<Icon icon={home} className="size-4" />);
    expect(container.querySelector("svg")?.getAttribute("width")).toBe("1em");
    expect(hrefOf(container)).toBeNull();
  });

  it("draws the default style's symbol while the wanted style's loads, then the wanted one", () => {
    act(() =>
      pageRuntimeSymbols.provide(
        "test-default",
        spriteOf("msr-default-outline-400-home"),
        [{ key: "default-outline-400", name: "home" }],
      ),
    );
    function Themed() {
      return (
        <IconScopeProvider scope="app-runtime">
          <Publish scope="app-runtime" style={rounded} />
          <Icon icon={home} />
        </IconScopeProvider>
      );
    }
    const { container } = render(<Themed />);
    expect(hrefOf(container)).toBe("#msr-default-outline-400-home");
    act(() =>
      pageRuntimeSymbols.provide(
        "test-rounded",
        spriteOf("msr-rounded-filled-300-home"),
        [{ key: "rounded-filled-300", name: "home" }],
      ),
    );
    expect(hrefOf(container)).toBe("#msr-rounded-filled-300-home");
  });
});

describe("<Icon> in a Lucide scope", () => {
  const lucide: IconStyle = { ...rounded, family: "lucide" };
  afterEach(() => provideIconFamilies("", null));

  it("draws Material while the Lucide family is not contributed", () => {
    provideGlyphs("rounded-filled-300", "folder", "grain");
    const { container } = render(
      <>
        <Publish scope="app:lucide-unregistered" style={lucide} />
        <IconScopeProvider scope="app:lucide-unregistered">
          <Icon icon={symbol("folder")} />
        </IconScopeProvider>
      </>,
    );
    expect(hrefOf(container)).toBe("#msr-rounded-filled-300-folder");
  });

  it("draws a mapped symbol's Lucide glyph once it lands, nothing until then — never its Material drawing swapped out a moment later", () => {
    act(() => provideIconFamilies("", [LUCIDE_FAMILY]));
    const { container } = render(
      <>
        <Publish scope="app:lucide" style={lucide} />
        <IconScopeProvider scope="app:lucide">
          <Icon icon={symbol("folder")} />
        </IconScopeProvider>
      </>,
    );
    expect(hrefOf(container)).toBeNull();
    provideGlyphs("lucide", "folder");
    expect(hrefOf(container)).toBe("#lucide-folder");
  });

  it("keeps the Material drawing, in the scope's style, for a material-only symbol", () => {
    act(() => provideIconFamilies("", [LUCIDE_FAMILY]));
    const { container } = render(
      <>
        <Publish scope="app:lucide-only" style={lucide} />
        <IconScopeProvider scope="app:lucide-only">
          <Icon icon={symbol("grain")} />
        </IconScopeProvider>
      </>,
    );
    expect(hrefOf(container)).toBe("#msr-rounded-filled-300-grain");
  });
});

describe("<Icon> with an app-drawn family", () => {
  const app = defineIconFamily({
    id: "test-app",
    label: "Test app",
    coverage: "fallback",
    fallback: "lucide",
    stroke: 1.7,
    glyphs: {
      x: { body: '<path d="M6 6l12 12"/>' },
      roll: { body: '<path d="M6 4v7"/>' },
    },
    symbols: { close: "x" },
  });
  const appStyle: IconStyle = { ...rounded, family: "test-app" };
  afterEach(() => provideIconFamilies("", null));

  function inApp(scope: string, icon: IconRef) {
    return render(
      <>
        <Publish scope={scope} style={appStyle} />
        <IconScopeProvider scope={scope}>
          <Icon icon={icon} />
        </IconScopeProvider>
      </>,
    ).container;
  }

  it("draws a mapped symbol from the family's own glyph", () => {
    act(() => provideIconFamilies("", [app, LUCIDE_FAMILY]));
    expect(hrefOf(inApp("app:fam-1", symbol("close")))).toBe("#fam-test-app-x");
  });

  it("falls down the chain for a name it does not map: Lucide, then Material", () => {
    act(() => provideIconFamilies("", [app, LUCIDE_FAMILY]));
    provideGlyphs("lucide", "folder");
    expect(hrefOf(inApp("app:fam-2", symbol("folder")))).toBe("#lucide-folder");
    expect(hrefOf(inApp("app:fam-3", symbol("grain")))).toBe(
      "#msr-rounded-filled-300-grain",
    );
  });

  it("draws a custom glyph from its family in any scope, an empty box until it is contributed", () => {
    const { container } = render(<Icon icon={app.icon("roll")} />);
    expect(hrefOf(container)).toBeNull();
    act(() => provideIconFamilies("", [app]));
    expect(hrefOf(container)).toBe("#fam-test-app-roll");
  });

  it("rejects a glyph body holding a non-shape element", () => {
    expect(() =>
      defineIconFamily({
        id: "bad",
        label: "Bad",
        coverage: "fallback",
        stroke: 1,
        glyphs: { x: { body: "<script>alert(1)</script>" } },
        symbols: {},
      }),
    ).toThrow(/not a shape element/);
  });
});
