import {
  StrictMode,
  createContext,
  useContext,
  useEffect,
  type ReactNode,
} from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import {
  PluginProvider,
  PluginScope,
} from "@plugins/framework/plugins/web-sdk/core";
import {
  PageRenderOrigin,
  RenderOrigin,
  useRenderOrigin,
  type RenderOriginHandle,
} from "../internal/render-origin";

afterEach(cleanup);

/** Stands for any context the raised content reads (a transport, a navigator). */
const World = createContext("page");

function ShowWorld({ label }: { label: string }) {
  return <p>{`${label} in ${useContext(World)}`}</p>;
}

/** Captures the origin its caller sees, as a raising hook would. */
function Capture({ into }: { into: (o: RenderOriginHandle) => void }) {
  into(useRenderOrigin());
  return null;
}

function inPlugins(children: ReactNode) {
  return <PluginProvider plugins={[]}>{children}</PluginProvider>;
}

const demo = { id: "demo-composition", home: null, plugins: [] };

describe("render origin", () => {
  it("renders raised content under the origin's contexts, not the host's", async () => {
    let origin: RenderOriginHandle | null = null;
    render(
      inPlugins(
        <World.Provider value="demo">
          <RenderOrigin>
            <Capture into={(o) => (origin = o)} />
          </RenderOrigin>
        </World.Provider>,
      ),
    );
    act(() => {
      origin!.raise(<ShowWorld label="toast" />);
    });
    expect(screen.getByText("toast in demo")).toBeTruthy();
  });

  it("settles `mounted` once the node committed, and `update` / `remove` act on it", async () => {
    let origin: RenderOriginHandle | null = null;
    render(
      inPlugins(
        <RenderOrigin>
          <Capture into={(o) => (origin = o)} />
        </RenderOrigin>,
      ),
    );
    let raised: ReturnType<RenderOriginHandle["raise"]> | null = null;
    act(() => {
      raised = origin!.raise(<p>first</p>);
    });
    await expect(raised!.mounted).resolves.toBeUndefined();
    act(() => raised!.update(<p>second</p>));
    expect(screen.getByText("second")).toBeTruthy();
    act(() => raised!.remove());
    expect(screen.queryByText("second")).toBeNull();
  });

  it("outside every scope, falls back to the page's origin", () => {
    let origin: RenderOriginHandle | null = null;
    render(
      inPlugins(
        <World.Provider value="page root">
          <PageRenderOrigin />
          <World.Provider value="caller">
            <Capture into={(o) => (origin = o)} />
          </World.Provider>
        </World.Provider>,
      ),
    );
    let raised: ReturnType<RenderOriginHandle["raise"]> | null = null;
    act(() => {
      raised = origin!.raise(<ShowWorld label="dialog" />);
    });
    expect(screen.getByText("dialog in page root")).toBeTruthy();
    act(() => raised!.remove());
  });

  it("inside a PluginScope, refuses an origin from outside the scope", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      render(
        inPlugins(
          <RenderOrigin>
            <PluginScope composition={demo}>
              <Capture into={() => {}} />
            </PluginScope>
          </RenderOrigin>,
        ),
      ),
    ).toThrow(/PluginScope "demo-composition".*no <RenderOrigin>/);
    vi.restoreAllMocks();
  });

  it("inside a PluginScope, uses the scope's own origin", () => {
    let origin: RenderOriginHandle | null = null;
    render(
      inPlugins(
        <PluginScope composition={demo}>
          <World.Provider value="demo">
            <RenderOrigin>
              <Capture into={(o) => (origin = o)} />
            </RenderOrigin>
          </World.Provider>
        </PluginScope>,
      ),
    );
    act(() => {
      origin!.raise(<ShowWorld label="toast" />);
    });
    expect(screen.getByText("toast in demo")).toBeTruthy();
  });

  it("when the origin unmounts, its raised content goes and `onGone` runs", async () => {
    let origin: RenderOriginHandle | null = null;
    const view = render(
      inPlugins(
        <RenderOrigin>
          <Capture into={(o) => (origin = o)} />
        </RenderOrigin>,
      ),
    );
    const onGone = vi.fn();
    act(() => {
      origin!.raise(<p>raised</p>, { onGone });
    });
    view.rerender(inPlugins(null));
    // The end is decided a microtask later (StrictMode's destroy → create).
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText("raised")).toBeNull();
    expect(onGone).toHaveBeenCalledTimes(1);
  });

  it("under StrictMode, keeps what a child raised from its own mount effect", async () => {
    const onGone = vi.fn();
    function RaiseOnMount() {
      const origin = useRenderOrigin();
      useEffect(() => {
        const raised = origin.raise(<p>raised on mount</p>, { onGone });
        return () => raised.remove();
      }, [origin]);
      return null;
    }
    render(
      <StrictMode>
        {inPlugins(
          <RenderOrigin>
            <RaiseOnMount />
          </RenderOrigin>,
        )}
      </StrictMode>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("raised on mount")).toBeTruthy();
    expect(onGone).not.toHaveBeenCalled();
  });
});
