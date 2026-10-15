import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import {
  createPluginRegistry,
  defineSlot,
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";

/**
 * Loading plugins re-renders only what reads a slot whose contribution list
 * changed. The boot path appends ~8 batches after first paint; before the
 * per-slot registry, each one re-rendered every slot reader in the app.
 */

const A = defineSlot<{ id: string }>();
const B = defineSlot<{ id: string }>();

function plugin(id: string, contributions: LoadedPlugin["contributions"]) {
  return { id: asPluginId(id), description: id, contributions };
}

afterEach(() => cleanup());

function mount() {
  const registry = createPluginRegistry();
  const renders = { a: 0, b: 0 };
  const seen: { a: unknown[]; b: unknown[] } = { a: [], b: [] };
  function ReaderA() {
    const items = A.useContributions();
    renders.a++;
    seen.a.push(items);
    return <span data-testid="a">{items.map((c) => c.id).join(",")}</span>;
  }
  function ReaderB() {
    const items = B.useContributions();
    renders.b++;
    seen.b.push(items);
    return <span data-testid="b">{items.map((c) => c.id).join(",")}</span>;
  }
  // `pass` only exists to re-render both readers from outside the registry.
  const tree = (pass: number) => (
    <PluginProvider
      registry={registry}
      composition={{ id: "test", home: null }}
    >
      <ReaderA key={`a${pass}`} />
      <ReaderB key={`b${pass}`} />
    </PluginProvider>
  );
  registry.append([plugin("p1", [A({ id: "a1" }), B({ id: "b1" })])]);
  const view = render(tree(0));
  return { registry, renders, seen, view, tree };
}

describe("per-slot registry reads", () => {
  it("an append re-renders the readers of the changed slot only", () => {
    const { registry, renders, view } = mount();
    expect(renders).toEqual({ a: 1, b: 1 });

    act(() => registry.append([plugin("p2", [A({ id: "a2" })])]));

    expect(view.getByTestId("a").textContent).toBe("a1,a2");
    expect(renders).toEqual({ a: 2, b: 1 });
  });

  it("an append that changes no slot re-renders nothing", () => {
    const { registry, renders } = mount();
    act(() => registry.append([plugin("p2", [])]));
    expect(renders).toEqual({ a: 1, b: 1 });
  });

  it("the sealed list keeps its identity while the slot is unchanged", () => {
    const { registry, seen, view, tree } = mount();
    act(() => registry.append([plugin("p2", [A({ id: "a2" })])]));
    // Remount both readers: B's list never changed, so B reads the same array.
    view.rerender(tree(1));
    expect(seen.b).toHaveLength(2);
    expect(seen.b[1]).toBe(seen.b[0]);
    expect(seen.a.at(-1)).not.toBe(seen.a[0]);
  });

  it("the plugins-prop form re-derives when the list is swapped", () => {
    function ReaderA() {
      return (
        <span data-testid="a">
          {A.useContributions()
            .map((c) => c.id)
            .join(",")}
        </span>
      );
    }
    const p1 = plugin("p1", [A({ id: "a1" })]);
    const view = render(
      <PluginProvider plugins={[p1]}>
        <ReaderA />
      </PluginProvider>,
    );
    expect(view.getByTestId("a").textContent).toBe("a1");
    view.rerender(
      <PluginProvider plugins={[p1, plugin("p2", [A({ id: "a2" })])]}>
        <ReaderA />
      </PluginProvider>,
    );
    expect(view.getByTestId("a").textContent).toBe("a1,a2");
  });
});
