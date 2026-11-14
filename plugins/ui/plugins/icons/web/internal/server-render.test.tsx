import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_ICON_STYLE, symbol, type SpriteKey } from "../../core";
import { Icon } from "./icon";
import { useIconFamilies } from "./family-store";
import {
  pageRuntimeSymbols,
  useRuntimeSymbolChunks,
  useWantedScopeSprites,
} from "./runtime-symbol-store";
import {
  provideSprite,
  useSpriteLoaded,
  useSprites,
  useWantedSprites,
} from "./sprite-store";
import { useScopeIconStyle, useScopeIconStyles } from "./style-store";

// A static render to HTML (react-dom/server, no DOM) reads every icon store
// through its server snapshot: it must not throw, and must answer what the
// store holds at that moment.

describe("icon stores under a server render", () => {
  it("draws an <Icon> from the stores as they stand", () => {
    // Not held yet: the box, nothing in it.
    const empty = renderToStaticMarkup(<Icon icon={symbol("home")} />);
    expect(empty).toStartWith("<svg");
    expect(empty).toContain('data-icon="home"');
    expect(empty).not.toContain("<use");
    pageRuntimeSymbols.provide(
      "server-render-home",
      '<svg><symbol id="msr-default-outline-400-home"></symbol></svg>',
      [{ key: "default-outline-400", name: "home" }],
    );
    const html = renderToStaticMarkup(<Icon icon={symbol("home")} />);
    expect(html).toContain('<use href="#msr-default-outline-400-home"');
  });

  it("reads each store hook's current value", () => {
    const key = "server-render-test" as SpriteKey;
    provideSprite(key, "<svg></svg>");
    function Probe() {
      const style = useScopeIconStyle([]);
      const styles = useScopeIconStyles([undefined]);
      return (
        <i>
          {[
            style.family,
            styles.length,
            useIconFamilies().length,
            useSpriteLoaded(key),
            useSprites().some(([k]) => k === key),
            useWantedSprites().length,
            useRuntimeSymbolChunks(pageRuntimeSymbols).length > 0,
            useWantedScopeSprites(pageRuntimeSymbols).length,
          ].join(",")}
        </i>
      );
    }
    expect(renderToStaticMarkup(<Probe />)).toBe(
      `<i>${DEFAULT_ICON_STYLE.family},1,0,true,true,0,true,0</i>`,
    );
  });
});
