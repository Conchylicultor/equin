import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  Core,
  defineRootSlot,
  defineSlot,
  PluginProvider,
  PluginScope,
  usePluginScopeId,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { RenderCoreRoot, RenderScopeRoot } from "../index";

// A root host declares where it mounts (`RootScope`): `"page"` once at the page
// root, `"each"` at the page root AND inside every `<PluginScope>`, reading
// that scope's contributions and id — so a scope is served by hosts of its
// own, whatever the page around it bundles.

const Items = defineSlot<{ name: string }>();
const CapabilityRoot = defineRootSlot();

function ItemsHost({ label }: { label: string }) {
  const where = usePluginScopeId() ?? "page";
  const names = Items.useContributions().map((c) => c.name);
  return <span data-testid={`${label}@${where}`}>{names.join(",")}</span>;
}

const plugin = (id: string, contributions: unknown[], slots?: object) =>
  ({ id, description: id, contributions, slots }) as unknown as LoadedPlugin;

const hosts = plugin(
  "hosts",
  [
    Core.Root({
      component: () => <ItemsHost label="page-host" />,
      scope: "page",
    }),
    Core.Root({
      component: () => <ItemsHost label="each-host" />,
      scope: "each",
    }),
    Core.Root({ slot: CapabilityRoot }),
    CapabilityRoot({
      component: () => <ItemsHost label="slot-each" />,
      scope: "each",
    }),
    CapabilityRoot({
      component: () => <ItemsHost label="slot-page" />,
      scope: "page",
    }),
    Items({ name: "page-item" }),
  ],
  { items: Items, capabilityRoot: CapabilityRoot },
);
const scoped = plugin("scoped", [Items({ name: "scope-item" })]);

afterEach(cleanup);

describe("root hosts and plugin scopes", () => {
  it("mounts `each` hosts again inside a scope, reading the scope's contributions", () => {
    render(
      <PluginProvider
        plugins={[hosts, scoped]}
        scopeRoots={<RenderScopeRoot />}
      >
        <RenderCoreRoot />
        <PluginScope
          composition={{ id: "demo", home: null, plugins: ["hosts", "scoped"] }}
        >
          <div />
        </PluginScope>
        <PluginScope
          composition={{ id: "narrow", home: null, plugins: ["hosts"] }}
        >
          <div />
        </PluginScope>
      </PluginProvider>,
    );
    // Page root: every host, the page's contributions.
    expect(screen.getByTestId("page-host@page").textContent).toBe(
      "page-item,scope-item",
    );
    expect(screen.getByTestId("each-host@page").textContent).toBe(
      "page-item,scope-item",
    );
    expect(screen.getByTestId("slot-page@page")).toBeTruthy();
    expect(screen.getByTestId("slot-each@page")).toBeTruthy();
    // Inside each scope: only the `each` hosts, through its own registry view.
    expect(screen.getByTestId("each-host@demo").textContent).toBe(
      "page-item,scope-item",
    );
    expect(screen.getByTestId("slot-each@demo")).toBeTruthy();
    expect(screen.getByTestId("each-host@narrow").textContent).toBe(
      "page-item",
    );
    expect(screen.queryByTestId("page-host@demo")).toBeNull();
    expect(screen.queryByTestId("slot-page@demo")).toBeNull();
  });

  it("mounts no hosts in a scope under a provider given none", () => {
    render(
      <PluginProvider plugins={[hosts]}>
        <PluginScope
          composition={{ id: "demo", home: null, plugins: ["hosts"] }}
        >
          <div />
        </PluginScope>
      </PluginProvider>,
    );
    expect(screen.queryByTestId("each-host@demo")).toBeNull();
  });
});
