import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import {
  Pane,
  PaneInstanceContext,
  useSyncPaneRegistry,
  paneMorphSink,
  type PaneExpandTarget,
  type PaneStore,
} from "@plugins/primitives/plugins/pane/web";
import { defineApp, defineRoute } from "@plugins/primitives/plugins/pane/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { PromoteControl } from "../components/promote-control";
import { createTestSurfaceStore, TestSurface } from "../testing";

// A pane declaring `expand` sends Expand to the other app's view of its
// subject, labelled for that app — and falls back to the default promote when
// that answers `none`.

const hostApp = defineApp({
  id: "expand-host",
  name: "Host",
  basePath: "/host",
  icon: symbol("science"),
});
const otherApp = defineApp({
  id: "expand-other",
  name: "Other",
  basePath: "/other",
  icon: symbol("science"),
});

const answers: Record<string, PaneExpandTarget> = {};
const clicks: string[] = [];

const listPane = Pane.define({
  route: defineRoute({ id: "exp-list", segment: "list" }),
  app: hostApp,
  component: () => null,
});
const peekPane = Pane.define({
  route: defineRoute({ id: "exp-peek", segment: "peek/:id" }),
  app: hostApp,
  useResolve: false,
  component: () => null,
  expand: {
    app: otherApp,
    useTarget: ({ id }) => answers[id]!,
  },
});

const plugins = [
  {
    id: "promote-control-expand-test-plugin",
    description: "promote-control expand fixture",
    contributions: [
      Pane.Register({ pane: listPane }),
      Pane.Register({ pane: peekPane }),
    ],
  } as unknown as LoadedPlugin,
];

function RegistrySync() {
  useSyncPaneRegistry();
  return null;
}

let store: PaneStore;

beforeAll(() => {
  render(
    <PluginProvider plugins={plugins}>
      <RegistrySync />
    </PluginProvider>,
  );
  cleanup();
});

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  store = createTestSurfaceStore();
  store.setBasePath("/host");
  clicks.length = 0;
});

afterEach(cleanup);

function renderPeek(id: string, opts: { inBox?: boolean } = {}) {
  store.restoreRoute([
    { paneId: "exp-list", params: {} },
    { paneId: "exp-peek", params: { id } },
  ]);
  const peek = store.getRoute()[1]!;
  return render(
    <TestSurface store={store} plugins={plugins} basePath="/host">
      <PaneInstanceContext.Provider value={peek.instanceId}>
        {opts.inBox ? (
          // What PaneBox stamps — the box the morph grows out of.
          <div data-pane-id="exp-peek" data-testid="box">
            <PromoteControl pane={peekPane} ancestorsHidden={false} />
          </div>
        ) : (
          <PromoteControl pane={peekPane} ancestorsHidden={false} />
        )}
      </PaneInstanceContext.Provider>
    </TestSurface>,
  );
}

describe("PromoteControl with expand", () => {
  it("opens the declared target, named for its app", () => {
    answers.a = {
      kind: "ready",
      target: { open: () => clicks.push("a"), href: () => "/other/a" },
    };
    const view = renderPeek("a");
    const button = view.getByRole("button", { name: "Open in Other" });
    fireEvent.click(button);
    expect(clicks).toEqual(["a"]);
  });

  it("shows the button disabled while the target is pending", () => {
    answers.b = { kind: "pending" };
    const view = renderPeek("b");
    const button = view.getByRole("button", { name: "Open in Other" });
    expect(button.hasAttribute("disabled")).toBe(true);
  });

  it("falls back to the default promote on none", () => {
    answers.c = { kind: "none" };
    const view = renderPeek("c");
    expect(view.getByRole("button", { name: "Expand pane" })).toBeTruthy();
  });
});

describe("PromoteControl morph", () => {
  const ready = (id: string): PaneExpandTarget => ({
    kind: "ready",
    target: { open: () => clicks.push(id), href: () => `/other/${id}` },
  });

  it("runs a cross-app open as a morph out of the enclosing pane box", () => {
    answers.m = ready("m");
    const morphs: HTMLElement[] = [];
    const uninstall = paneMorphSink.install((from, open) => {
      morphs.push(from);
      open();
    });
    try {
      const view = renderPeek("m", { inBox: true });
      fireEvent.click(view.getByRole("button", { name: "Open in Other" }));
      expect(morphs).toEqual([view.getByTestId("box")]);
      expect(clicks).toEqual(["m"]);
    } finally {
      uninstall();
    }
  });

  it("opens plainly with no morph installed", () => {
    answers.n = ready("n");
    const view = renderPeek("n", { inBox: true });
    fireEvent.click(view.getByRole("button", { name: "Open in Other" }));
    expect(clicks).toEqual(["n"]);
  });

  it("opens plainly outside a pane box", () => {
    answers.o = ready("o");
    let morphed = false;
    const uninstall = paneMorphSink.install((_from, open) => {
      morphed = true;
      open();
    });
    try {
      const view = renderPeek("o");
      fireEvent.click(view.getByRole("button", { name: "Open in Other" }));
      expect(morphed).toBe(false);
      expect(clicks).toEqual(["o"]);
    } finally {
      uninstall();
    }
  });
});
