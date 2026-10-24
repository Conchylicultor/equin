import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { DEFAULT_ICON_STYLE, type IconStyle } from "../../core/style";
import {
  usePublishIconStyle,
  useScopeIconStyles,
} from "../internal/style-store";

afterEach(cleanup);

const AGENT: IconStyle = { ...DEFAULT_ICON_STYLE, family: "agent" };

function Publisher({ scope, style }: { scope: string; style: IconStyle }) {
  usePublishIconStyle(scope, style);
  return null;
}

function Reader({ scopes }: { scopes: readonly string[] }) {
  const styles = useScopeIconStyles(scopes);
  return <output>{styles.map((s) => s.family).join(",")}</output>;
}

describe("useScopeIconStyles", () => {
  it("follows a style published after the reader mounted", () => {
    // Debug → Icons mounts before the bridge has published every app scope:
    // the list must update, never freeze at its first read.
    function Harness({ on }: { on: boolean }) {
      return (
        <>
          <Reader scopes={["app:a", "app:b"]} />
          {on ? <Publisher scope="app:a" style={AGENT} /> : null}
        </>
      );
    }
    const { container, rerender } = render(<Harness on={false} />);
    expect(container.textContent).toBe("material,material");
    act(() => rerender(<Harness on />));
    expect(container.textContent).toBe("agent,material");
    act(() => rerender(<Harness on={false} />));
    expect(container.textContent).toBe("material,material");
  });
});
