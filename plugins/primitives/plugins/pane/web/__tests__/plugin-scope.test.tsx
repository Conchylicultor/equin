import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import {
  defineSlot,
  PluginProvider,
  PluginScope,
  useComposition,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import {
  Pane,
  routeHomeApp,
  useSyncPaneRegistry,
  type PaneSlot,
} from "@plugins/primitives/plugins/pane/web";
import { defineApp, defineRoute } from "@plugins/primitives/plugins/pane/core";

// A `PluginScope` renders its subtree as another composition: slot reads see
// only the scope's plugins, `useComposition()` answers the scope — except for
// `Pane.Register`, a PAGE-WIDE slot. The pane registry is one module-global map
// refilled by every `useSyncPaneRegistry` (the apps root AND an embedded
// app's surface), so a scoped inner sync would drop the outer app's panes for
// the whole page.

const outerApp = defineApp({
  id: "scope-outer",
  name: "Outer",
  basePath: "/scope-outer",
  iconKey: "science",
});
const innerApp = defineApp({
  id: "scope-inner",
  name: "Inner",
  basePath: "/scope-inner",
  iconKey: "science",
});
const outerPane = Pane.define({
  route: defineRoute({ id: "scope-outer-list", segment: "outer-list" }),
  app: outerApp,
  component: () => null,
});
const innerPane = Pane.define({
  route: defineRoute({ id: "scope-inner-list", segment: "inner-list" }),
  app: innerApp,
  component: () => null,
});

const Items = defineSlot<{ label: string }>();

const plugins = [
  {
    id: "scope-test-outer",
    description: "outside the scope",
    contributions: [
      Pane.Register({ pane: outerPane }),
      Items({ label: "outer item" }),
    ],
  },
  {
    id: "scope-test-inner",
    description: "inside the scope",
    contributions: [
      Pane.Register({ pane: innerPane }),
      Items({ label: "inner item" }),
    ],
  },
] as unknown as LoadedPlugin[];

const host = {
  id: "scope-host",
  home: "scope-inner",
  plugins: ["scope-test-inner"],
};

function RegistrySync() {
  useSyncPaneRegistry();
  return null;
}

function ItemList() {
  const items = Items.useContributions();
  return (
    <ul>
      {items.map((i) => (
        <li key={i.label}>{i.label}</li>
      ))}
    </ul>
  );
}

function CompositionProbe() {
  const { id, home } = useComposition();
  return <p>{`${id}:${home ?? "none"}`}</p>;
}

afterEach(() => {
  cleanup();
});

describe("PluginScope", () => {
  it("drops out-of-scope contributions inside the scope only", () => {
    render(
      <PluginProvider
        plugins={plugins}
        composition={{ id: "page", home: "scope-outer" }}
      >
        <section aria-label="page">
          <ItemList />
          <CompositionProbe />
        </section>
        <PluginScope composition={host}>
          <section aria-label="scoped">
            <ItemList />
            <CompositionProbe />
          </section>
        </PluginScope>
      </PluginProvider>,
    );
    const page = screen.getByRole("region", { name: "page" });
    const scoped = screen.getByRole("region", { name: "scoped" });
    expect(page.textContent).toContain("outer item");
    expect(page.textContent).toContain("inner item");
    expect(page.textContent).toContain("page:scope-outer");
    expect(scoped.textContent).not.toContain("outer item");
    expect(scoped.textContent).toContain("inner item");
    expect(scoped.textContent).toContain("scope-host:scope-inner");
  });

  it("an outer pane still resolves after a scoped surface syncs the registry", () => {
    render(
      <PluginProvider plugins={plugins}>
        <RegistrySync />
        <PluginScope composition={host}>
          <RegistrySync />
        </PluginScope>
      </PluginProvider>,
    );
    const head = (paneId: string): PaneSlot[] => [
      {
        instanceId: 0,
        uuid: paneId,
        paneId,
        params: {},
        options: {},
        hint: {},
      },
    ];
    expect(routeHomeApp(head("scope-outer-list"))?.id).toBe("scope-outer");
    expect(routeHomeApp(head("scope-inner-list"))?.id).toBe("scope-inner");
  });
});
