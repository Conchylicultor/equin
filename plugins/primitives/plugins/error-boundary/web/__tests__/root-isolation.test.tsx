import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  Core,
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { RenderCoreRoot } from "@plugins/primitives/plugins/slot-render/web";
import errorBoundaryPlugin from "../index";

// Core.Root used to be rendered by hand in App.tsx, each mount wrapped in a
// manual <PluginErrorBoundary>. It now goes through slot-render's item
// middlewares like every other slot, so isolation is THIS plugin's companion
// middleware — pinned here: one crashing root mount must not take its siblings
// (the toaster, the dialog host, the action bar) down with it.

function Boom(): never {
  throw new Error("boom");
}

const consoleError = console.error;
afterEach(() => {
  cleanup();
  console.error = consoleError;
});

describe("Core.Root mounts are isolated one by one", () => {
  it("a crashing root mount leaves its siblings mounted", () => {
    console.error = () => {};
    const roots = {
      id: "test.roots",
      description: "root mounts",
      contributions: [
        Core.Root({ component: Boom }),
        Core.Root({ component: () => <div data-testid="sibling" /> }),
      ],
    } as unknown as LoadedPlugin;
    const { getByTestId } = render(
      <PluginProvider
        plugins={[errorBoundaryPlugin as unknown as LoadedPlugin, roots]}
      >
        <RenderCoreRoot />
      </PluginProvider>,
    );
    expect(getByTestId("sibling")).toBeTruthy();
  });
});
