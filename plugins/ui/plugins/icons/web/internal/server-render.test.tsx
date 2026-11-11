import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { symbol, type SpriteKey } from "../../core";
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
import {
  iconStyleOf,
  useScopeIconStyle,
  useScopeIconStyles,
  useWantedStyleKeys,
} from "./style-store";

// A static render to HTML (react-dom/server, no DOM) reads every icon store
// through its server snapshot: it must not throw, and must answer what the
// store holds at that moment.

describe("icon stores under a server render", () => {
  it("draws an <Icon> from the stores as they stand", () => {
    const html = renderToStaticMarkup(<Icon icon={symbol("home")} />);
    expect(html).toStartWith("<svg");
    expect(html).toContain('data-icon="home"');
    expect(html).toContain("<use href=");
  });

  it("reads each store hook's current value", () => {
    const key = "server-render-test" as SpriteKey;
    provideSprite(key, "<svg></svg>");
    function Probe() {
      const style = useScopeIconStyle(undefined);
      const styles = useScopeIconStyles([undefined]);
      return (
        <i>
          {[
            style.family,
            styles.length,
            useWantedStyleKeys().length > 0,
            useIconFamilies().length,
            useSpriteLoaded(key),
            useSprites().some(([k]) => k === key),
            useWantedSprites().length,
            useRuntimeSymbolChunks(pageRuntimeSymbols).length,
            useWantedScopeSprites(pageRuntimeSymbols).length,
          ].join(",")}
        </i>
      );
    }
    expect(renderToStaticMarkup(<Probe />)).toBe(
      `<i>${iconStyleOf(undefined).family},1,true,0,true,true,0,0,0</i>`,
    );
  });
});
