import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import {
  PluginProvider,
  PluginScope,
} from "@plugins/framework/plugins/web-sdk/core";
import { runtimeSymbol, type SavedSymbolName } from "../../core/icon-ref";
import { Icon } from "../internal/icon";
import {
  RuntimeSymbolScope,
  createScopedRuntimeSymbols,
  pageRuntimeSymbols,
  type GlyphEntry,
} from "../internal/runtime-symbol-store";
import { RuntimeSymbolSheet } from "../internal/sprite-sheet";

/**
 * A saved icon draws from its scope's own store: the page's outside every
 * plugin scope, the scope's inside one — never the page's, whose loader reads
 * the PAGE's server.
 */

afterEach(cleanup);

const demo = { id: "demo-composition", home: null, plugins: [] };
const star = runtimeSymbol("star" as SavedSymbolName);

function inPlugins(children: ReactNode) {
  return <PluginProvider plugins={[]}>{children}</PluginProvider>;
}

function hrefOf(container: HTMLElement): string | null {
  return container.querySelector("use")?.getAttribute("href") ?? null;
}

describe("runtime symbols in a plugin scope", () => {
  it("draws from the scope's own store, its wants going to that store's loader", () => {
    const store = createScopedRuntimeSymbols();
    const scopeWants: GlyphEntry[] = [];
    const pageWants: GlyphEntry[] = [];
    const offScope = store.installLoader((e) => scopeWants.push(e));
    const offPage = pageRuntimeSymbols.installLoader((e) => pageWants.push(e));
    const { container } = render(
      inPlugins(
        <PluginScope composition={demo}>
          <RuntimeSymbolScope store={store}>
            <Icon icon={star} />
            <RuntimeSymbolSheet store={store} />
          </RuntimeSymbolScope>
        </PluginScope>,
      ),
    );
    expect(scopeWants).toEqual([{ key: "default-outline-400", name: "star" }]);
    expect(pageWants).toEqual([]);
    act(() =>
      store.provide(
        "batch",
        '<svg><symbol id="msr-default-outline-400-star"></symbol></svg>',
        scopeWants,
      ),
    );
    const href = hrefOf(container);
    expect(href).toBe(`#${store.symbolId("default-outline-400", "star")}`);
    expect(href).not.toBe("#msr-default-outline-400-star");
    // The scope's sheet holds the symbol under the same, prefixed id.
    expect(container.querySelector(href!)).not.toBeNull();
    offScope();
    offPage();
  });

  it("throws for a saved icon in a scope that mounted no store of its own", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      render(
        inPlugins(
          <RuntimeSymbolScope store={createScopedRuntimeSymbols()}>
            <PluginScope composition={demo}>
              <Icon icon={star} />
            </PluginScope>
          </RuntimeSymbolScope>,
        ),
      ),
    ).toThrow(/plugin scope "demo-composition".*no runtime-symbol store/);
    vi.restoreAllMocks();
  });
});
