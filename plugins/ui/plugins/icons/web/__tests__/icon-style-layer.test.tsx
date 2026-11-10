import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { DEFAULT_ICON_STYLE, type IconStyle } from "../../core/style";
import { IconScopeProvider } from "../internal/icon-scope";
import { useIconStyle } from "../internal/icon";
import {
  usePublishIconStyle,
  usePublishIconStyleLayer,
} from "../internal/style-store";

// A sub-theme is a layer over the scope around it: its icons draw in the
// enclosing scope's style with only the axes it names changed — whichever app
// hosts it (the media player's filled icons in Sonata stay Sonata's family).

afterEach(cleanup);

const SONATA: IconStyle = { ...DEFAULT_ICON_STYLE, family: "sonata" };
const DESKTOP: IconStyle = { ...DEFAULT_ICON_STYLE, family: "desktop" };

function Publishers() {
  usePublishIconStyle(undefined, DESKTOP);
  usePublishIconStyle("app:sonata", SONATA);
  usePublishIconStyleLayer("sub:player", { fill: "filled" });
  return null;
}

function Probe() {
  const style = useIconStyle();
  return (
    <output>
      {style.family}/{style.fill}
    </output>
  );
}

describe("an icon style layer", () => {
  it("is worn over the nearest whole style enclosing it", () => {
    const { container } = render(
      <>
        <Publishers />
        <IconScopeProvider scope="app:sonata">
          <IconScopeProvider scope="sub:player">
            <Probe />
          </IconScopeProvider>
        </IconScopeProvider>
      </>,
    );
    expect(container.textContent).toBe("sonata/filled");
  });

  it("is worn over the root's style outside every app", () => {
    const { container } = render(
      <>
        <Publishers />
        <IconScopeProvider scope="sub:player">
          <Probe />
        </IconScopeProvider>
      </>,
    );
    expect(container.textContent).toBe("desktop/filled");
  });

  it("does not reach a whole scope nested inside its region", () => {
    const { container } = render(
      <>
        <Publishers />
        <IconScopeProvider scope="sub:player">
          <IconScopeProvider scope="app:sonata">
            <Probe />
          </IconScopeProvider>
        </IconScopeProvider>
      </>,
    );
    expect(container.textContent).toBe(`sonata/${DEFAULT_ICON_STYLE.fill}`);
  });
});
