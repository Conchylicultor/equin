import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import {
  brand,
  runtimeSymbol,
  seti,
  symbol,
  type IconRef,
  type SavedSymbolName,
} from "../../core/icon-ref";
import type { IconStyle } from "../../core/style";
import { defineIconFamily } from "../../core/icon-family";
import { LUCIDE_FAMILY } from "../../core/lucide-map";
import { provideIconFamilies } from "../internal/family-store";
import { resolveIconSource } from "../internal/icon-drawing";
import {
  iconFamilyGapReportSink,
  type IconFamilyGap,
} from "../internal/family-gap";
import { Icon } from "../internal/icon";
import { IconFamilyPreview, IconScopeProvider } from "../internal/icon-scope";
import { usePublishIconStyle } from "../internal/style-store";
import { provideSprite } from "../internal/sprite-store";
import { provideRuntimeSymbols } from "../internal/runtime-symbol-store";

/**
 * Coverage: where a family's drawing of a name comes from (resolveIconSource),
 * a strict scope's gap glyph — never Material — and its one report; and the
 * inline drawing of an animated glyph.
 */

afterEach(() => {
  cleanup();
  provideIconFamilies([]);
  iconFamilyGapReportSink.register(null);
});

const base: IconStyle = {
  family: "material",
  shape: "default",
  fill: "outline",
  activeFill: "filled",
  weight: "regular",
};

const fallbackFam = defineIconFamily({
  id: "cov-fallback",
  label: "Fallback",
  coverage: "fallback",
  fallback: "lucide",
  stroke: 1.6,
  glyphs: {
    x: { body: '<path d="M6 6l12 12"/>' },
    arrow: { body: '<path data-motion="nudge-right" d="M10 7l5 5-5 5"/>' },
  },
  symbols: { close: "x", "chevron-right": "arrow" },
});

const strictFam = defineIconFamily({
  id: "cov-strict",
  label: "Strict",
  coverage: "strict",
  stroke: 1.6,
  glyphs: { x: { body: '<path d="M6 6l12 12"/>' } },
  symbols: { close: "x" },
});

function Publish({ scope, style }: { scope: string; style: IconStyle }) {
  usePublishIconStyle(scope, style);
  return null;
}

function inScope(scope: string, family: string, icon: IconRef) {
  return render(
    <>
      <Publish scope={scope} style={{ ...base, family }} />
      <IconScopeProvider scope={scope}>
        <Icon icon={icon} />
      </IconScopeProvider>
    </>,
  ).container;
}

function hrefOf(container: HTMLElement): string | null {
  return container.querySelector("use")?.getAttribute("href") ?? null;
}

describe("resolveIconSource", () => {
  it("own, fallback down the chain, and Material at its end", () => {
    act(() => provideIconFamilies([fallbackFam, LUCIDE_FAMILY]));
    expect(resolveIconSource("close", "cov-fallback")).toEqual({
      kind: "own",
      glyph: "x",
    });
    expect(resolveIconSource("folder", "cov-fallback")).toEqual({
      kind: "fallback",
      family: "lucide",
    });
    expect(resolveIconSource("grain", "cov-fallback")).toEqual({
      kind: "fallback",
      family: "material",
    });
    expect(resolveIconSource("grain", "material")).toEqual({
      kind: "own",
      glyph: "grain",
    });
  });

  it("a strict family's unmapped name is a gap", () => {
    act(() => provideIconFamilies([strictFam]));
    expect(resolveIconSource("close", "cov-strict")).toEqual({
      kind: "own",
      glyph: "x",
    });
    expect(resolveIconSource("folder", "cov-strict")).toEqual({
      kind: "gap",
      family: "cov-strict",
    });
  });

  it("a family not contributed falls to Material", () => {
    expect(resolveIconSource("close", "cov-strict")).toEqual({
      kind: "fallback",
      family: "material",
    });
  });
});

describe("<IconFamilyPreview>", () => {
  it("draws the icons below in its family, in a Material scope, and never reports a gap", () => {
    const gaps: IconFamilyGap[] = [];
    iconFamilyGapReportSink.register((g) => gaps.push(g));
    act(() => provideIconFamilies([strictFam]));
    const draw = (icon: IconRef) =>
      hrefOf(
        render(
          <IconFamilyPreview family="cov-strict">
            <Icon icon={icon} />
          </IconFamilyPreview>,
        ).container,
      );
    expect(draw(symbol("close"))).toBe("#fam-cov-strict-x");
    expect(draw(symbol("search"))).toBe("#famgap-cov-strict");
    expect(gaps).toEqual([]);
  });
});

describe("<Icon> in a strict scope", () => {
  it("draws the gap glyph, not Material, for an unmapped symbol — and reports it once", () => {
    const gaps: IconFamilyGap[] = [];
    iconFamilyGapReportSink.register((g) => gaps.push(g));
    act(() => provideIconFamilies([strictFam]));
    expect(
      hrefOf(inScope("app:strict-1", "cov-strict", symbol("folder"))),
    ).toBe("#famgap-cov-strict");
    expect(
      hrefOf(inScope("app:strict-2", "cov-strict", symbol("folder"))),
    ).toBe("#famgap-cov-strict");
    expect(gaps).toEqual([{ family: "cov-strict", name: "folder" }]);
    expect(hrefOf(inScope("app:strict-3", "cov-strict", symbol("close")))).toBe(
      "#fam-cov-strict-x",
    );
  });

  it("leaves brand, seti, runtime-symbol and custom icons alone", () => {
    const gaps: IconFamilyGap[] = [];
    iconFamilyGapReportSink.register((g) => gaps.push(g));
    act(() => provideIconFamilies([strictFam, fallbackFam]));
    act(() => provideSprite("seti", "<svg></svg>"));
    act(() =>
      provideRuntimeSymbols("cov-runtime", "<svg></svg>", [
        { styleKey: "default-outline-400", name: "home" },
      ]),
    );
    expect(hrefOf(inScope("app:ex-1", "cov-strict", brand("github")))).toBe(
      "#si-github",
    );
    expect(hrefOf(inScope("app:ex-2", "cov-strict", seti("typescript")))).toBe(
      "#seti-typescript",
    );
    expect(
      hrefOf(
        inScope(
          "app:ex-3",
          "cov-strict",
          runtimeSymbol("home" as SavedSymbolName),
        ),
      ),
    ).toBe("#msr-default-outline-400-home");
    expect(
      hrefOf(inScope("app:ex-4", "cov-strict", fallbackFam.icon("x"))),
    ).toBe("#fam-cov-fallback-x");
    expect(gaps).toEqual([]);
  });
});

describe("<Icon> drawing an animated glyph", () => {
  it("draws it inline, with the family paint, so motion CSS reaches its parts", () => {
    act(() => provideIconFamilies([fallbackFam, LUCIDE_FAMILY]));
    const c = inScope("app:anim-1", "cov-fallback", symbol("chevron-right"));
    expect(c.querySelector("use")).toBeNull();
    const part = c.querySelector('[data-motion="nudge-right"]');
    expect(part).not.toBeNull();
    expect(part!.parentElement!.getAttribute("stroke-width")).toBe("1.6");
  });

  it("draws an animated app-only glyph (a custom ref) inline too, in any scope", () => {
    act(() => provideIconFamilies([fallbackFam, LUCIDE_FAMILY]));
    const c = inScope("app:anim-3", "material", fallbackFam.icon("arrow"));
    expect(c.querySelector("use")).toBeNull();
    expect(c.querySelector('[data-motion="nudge-right"]')).not.toBeNull();
  });

  it("keeps <use> for a still glyph", () => {
    act(() => provideIconFamilies([fallbackFam, LUCIDE_FAMILY]));
    expect(hrefOf(inScope("app:anim-2", "cov-fallback", symbol("close")))).toBe(
      "#fam-cov-fallback-x",
    );
  });
});
