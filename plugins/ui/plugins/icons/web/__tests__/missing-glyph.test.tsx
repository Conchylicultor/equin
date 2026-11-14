import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { brand, symbol } from "../../core/icon-ref";
import { Icon } from "../internal/icon";
import { provideSprite } from "../internal/sprite-store";
import { pageRuntimeSymbols } from "../internal/runtime-symbol-store";
import {
  iconMissingGlyphReportSink,
  type IconMissingGlyph,
} from "../internal/missing-glyph";

/**
 * A glyph its batch was asked for and did not carry (the server draws no such
 * glyph), or a held whole sprite without the icon's symbol, is drawn as the
 * missing-glyph marker and reported, once per (key, id) per page: never a
 * `<use>` of nothing.
 */

afterEach(() => {
  cleanup();
  iconMissingGlyphReportSink.register(null);
});

describe("<Icon> whose glyph or sprite lacks its symbol", () => {
  it("draws the marker and reports the missing glyph once", () => {
    const reported: IconMissingGlyph[] = [];
    iconMissingGlyphReportSink.register((m) => reported.push(m));
    act(() =>
      pageRuntimeSymbols.provide(
        "missing-test",
        '<svg><symbol id="msr-default-outline-400-forum" viewBox="0 0 24 24"></symbol></svg>',
        [
          { key: "default-outline-400", name: "forum" },
          { key: "default-outline-400", name: "progress-activity" },
        ],
      ),
    );
    const held = render(<Icon icon={symbol("forum")} />).container;
    expect(held.querySelector("use")?.getAttribute("href")).toBe(
      "#msr-default-outline-400-forum",
    );

    const { container } = render(
      <>
        <Icon icon={symbol("progress-activity")} />
        <Icon icon={symbol("progress-activity")} />
      </>,
    );
    expect(container.querySelector("use")).toBeNull();
    expect(container.querySelectorAll("svg rect")).toHaveLength(2);
    expect(reported).toEqual([
      {
        sprite: "default-outline-400",
        id: "msr-default-outline-400-progress-activity",
      },
    ]);
  });

  it("checks a brand against the brands sprite", () => {
    const reported: IconMissingGlyph[] = [];
    iconMissingGlyphReportSink.register((m) => reported.push(m));
    act(() => provideSprite("brands", "<svg></svg>"));
    render(<Icon icon={brand("github")} />);
    expect(reported).toEqual([{ sprite: "brands", id: "si-github" }]);
  });
});
