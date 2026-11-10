import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

import { RenderScopeRoot } from "@plugins/primitives/plugins/slot-render/web";
import {
  createPluginRegistry,
  defineSlot,
  PluginProvider,
  PluginScope,
  useScopedOutContributions,
  useScopePlugins,
  type LoadedPlugin,
  type OnDemandPlugins,
  type ScopedComposition,
} from "@plugins/framework/plugins/web-sdk/core";

// A page whose registry also holds plugins ON DEMAND (a browser host's page
// scope its own composition lacks — the standalone site's demo): they are
// loaded only when a scope asks (`useScopePlugins`), and contribute to
// nothing outside such a scope, so the page around the demo is the page it
// was without it.

const Item = defineSlot<{ id: string }>();

function plugin(id: string, contributions: LoadedPlugin["contributions"]) {
  return { id, description: id, contributions } as LoadedPlugin;
}

const OWN = plugin("page.own", [Item({ id: "own" })]);
const SCOPED = plugin("demo.scoped", [Item({ id: "scoped" })]);

const SCOPE: ScopedComposition = {
  id: "demo",
  home: null,
  plugins: ["page.own", "demo.scoped"],
};

function Items({ testId }: { testId: string }) {
  const items = Item.useContributions();
  return <span data-testid={testId}>{items.map((c) => c.id).join(",")}</span>;
}

/** A registry holding `OWN`, with `SCOPED` on demand, loaded when asked. */
function setup() {
  const registry = createPluginRegistry();
  registry.append([OWN]);
  const loaded = new Set<string>();
  let release: () => void = () => {};
  const asked: string[][] = [];
  const onDemand: OnDemandPlugins = {
    ids: new Set([SCOPED.id]),
    isLoaded: (id) => loaded.has(id),
    load(ids) {
      asked.push([...ids]);
      return new Promise<void>((resolve) => {
        release = () => {
          registry.append([SCOPED]);
          loaded.add(SCOPED.id);
          resolve();
        };
      });
    },
  };
  const page = (children: ReactNode) => (
    <PluginProvider
      registry={registry}
      composition={{ id: "page", home: null }}
      scopeRoots={<RenderScopeRoot />}
      onDemand={onDemand}
    >
      {children}
    </PluginProvider>
  );
  return { page, asked, release: () => release() };
}

function Demo({ enabled }: { enabled: boolean }) {
  const state = useScopePlugins(SCOPE, enabled);
  if (state.kind !== "ready")
    return <span data-testid="demo">{state.kind}</span>;
  return (
    <PluginScope composition={SCOPE}>
      <Items testId="demo" />
    </PluginScope>
  );
}

afterEach(cleanup);

describe("on-demand plugins", () => {
  it("loads nothing until the scope may start, then renders it with its plugins", async () => {
    const { page, asked, release } = setup();
    const view = render(
      page(
        <>
          <Items testId="page" />
          <Demo enabled={false} />
        </>,
      ),
    );
    expect(screen.getByTestId("demo").textContent).toBe("pending");
    expect(asked).toEqual([]);

    view.rerender(
      page(
        <>
          <Items testId="page" />
          <Demo enabled />
        </>,
      ),
    );
    expect(asked).toEqual([["demo.scoped"]]);
    await act(async () => release());

    // Inside the scope: its own plugins, the on-demand one included…
    expect(screen.getByTestId("demo").textContent).toBe("own,scoped");
    // …outside it, the page is what it was: the loaded plugin reaches nothing.
    expect(screen.getByTestId("page").textContent).toBe("own");
  });

  it("another root-level scope counts a loaded on-demand plugin as left out on purpose, never scoped out", async () => {
    const { page, release } = setup();
    function ScopedOut() {
      const out = useScopedOutContributions(Item);
      return <span data-testid="out">{out.map((c) => c.id).join(",")}</span>;
    }
    render(
      page(
        <>
          <Demo enabled />
          <PluginScope composition={{ id: "other", home: null, plugins: [] }}>
            <ScopedOut />
          </PluginScope>
        </>,
      ),
    );
    await act(async () => release());
    expect(screen.getByTestId("demo").textContent).toBe("own,scoped");
    // The page's own plugin is scoped out of "other"; the demo's is not its.
    expect(screen.getByTestId("out").textContent).toBe("own");
  });

  it("refuses to render a scope whose on-demand plugins are not loaded", () => {
    const { page } = setup();
    expect(() =>
      render(
        page(
          <PluginScope composition={SCOPE}>
            <Items testId="demo" />
          </PluginScope>,
        ),
      ),
    ).toThrow(/on demand and not loaded \(demo\.scoped\)/);
  });

  it("is ready at once for a scope that needs nothing on demand", () => {
    const registry = createPluginRegistry();
    registry.append([OWN, SCOPED]);
    render(
      <PluginProvider
        registry={registry}
        composition={{ id: "page", home: null }}
        scopeRoots={<RenderScopeRoot />}
      >
        <Items testId="page" />
        <Demo enabled={false} />
      </PluginProvider>,
    );
    expect(screen.getByTestId("demo").textContent).toBe("own,scoped");
    expect(screen.getByTestId("page").textContent).toBe("own,scoped");
  });
});
