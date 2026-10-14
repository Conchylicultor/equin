import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import {
  Pane,
  PaneInstanceContext,
  setLiveStore,
  useOpenPane,
  useSyncPaneRegistry,
  type OpenPaneFn,
  type PaneStore,
} from "@plugins/primitives/plugins/pane/web";
import {
  linkProps,
  type LinkGestureProps,
} from "@plugins/primitives/plugins/link-gesture/web";
import { defineApp, defineRoute } from "@plugins/primitives/plugins/pane/core";
import { computeOpen } from "../pane";
import { createTestSurfaceStore, TestSurface, defaultStore } from "../testing";

// A LINK'S URL IS WHERE ITS CLICK GOES.
//
// `openPane.link(...)` hands a control both halves of a link: plain click opens
// the pane, ⌘/middle-click opens the URL of the route that click would produce
// in a new browser tab. Both halves read one `computeOpen`, and this suite pins
// what that buys: for every open shape, the URL the gesture hands the browser is
// exactly the address bar after the plain click — and the gesture itself leaves
// the route alone.

const linkApp = defineApp({
  id: "link-app",
  name: "Link test app",
  basePath: "/lnk",
  iconKey: "science",
});

const convPane = Pane.define({
  route: defineRoute({ id: "lnk-conv", segment: "c/:convId" }),
  app: linkApp,
  useResolve: false,
  component: () => null,
});
const listRoute = defineRoute({ id: "lnk-list", segment: "list" });
const listPane = Pane.define({
  route: listRoute,
  app: linkApp,
  component: () => null,
});
const itemPane = Pane.define({
  route: defineRoute({
    id: "lnk-item",
    segment: "item/:itemId",
    parent: listRoute,
  }),
  app: linkApp,
  useResolve: false,
  component: () => null,
});
const plainPane = Pane.define({
  route: defineRoute({ id: "lnk-plain", segment: "plain" }),
  app: linkApp,
  component: () => null,
});

const testPlugin = {
  id: "open-pane-link-test-plugin",
  description: "open-pane link fixture",
  contributions: [
    Pane.Register({ pane: convPane }),
    Pane.Register({ pane: listPane }),
    Pane.Register({ pane: itemPane }),
    Pane.Register({ pane: plainPane }),
  ],
} as unknown as LoadedPlugin;
const plugins = [testPlugin];

function RegistrySync() {
  useSyncPaneRegistry();
  return null;
}

function LinkButton({
  props,
}: {
  props: (open: OpenPaneFn) => LinkGestureProps;
}) {
  const openPane = useOpenPane();
  return (
    <button type="button" {...props(openPane)}>
      open
    </button>
  );
}

let store: PaneStore;
let opened: string[];

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
  // Before any seed, so the seeded route's address bar already carries it —
  // the surface would otherwise only apply it on render, after the seed wrote
  // its URL bare.
  store.setBasePath("/lnk");
  opened = [];
  vi.spyOn(window, "open").mockImplementation((url) => {
    opened.push(String(url));
    return null;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setLiveStore(defaultStore);
  window.history.replaceState(null, "", "/");
});

type Seed = Array<{ paneId: string; params: Record<string, string> }>;

function mount(
  seed: Seed,
  props: (open: OpenPaneFn) => LinkGestureProps,
  callerIndex?: number,
): HTMLElement {
  store.restoreRoute(seed);
  const callerInstanceId =
    callerIndex === undefined
      ? undefined
      : store.getRoute()[callerIndex]!.instanceId;
  const view = render(
    <TestSurface store={store} plugins={plugins} basePath="/lnk">
      <PaneInstanceContext.Provider value={callerInstanceId}>
        <LinkButton props={props} />
      </PaneInstanceContext.Provider>
    </TestSurface>,
  );
  return view.getByRole("button");
}

const shape = () =>
  store.getRoute().map((s) => ({ paneId: s.paneId, params: s.params }));

function middleClick(el: HTMLElement): void {
  fireEvent.mouseDown(el, { button: 1 });
  fireEvent(
    el,
    new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }),
  );
}

/**
 * The property itself: the gesture opens a browser tab at some URL without
 * touching the route, and the plain click then lands on exactly that URL.
 */
function expectLinkMatchesClick(button: HTMLElement): string {
  const before = shape();
  const urlBefore = window.location.pathname;

  middleClick(button);
  fireEvent.click(button, { metaKey: true });
  expect(opened).toHaveLength(2);
  expect(opened[0]).toBe(opened[1]);
  expect(shape()).toEqual(before);
  expect(window.location.pathname).toBe(urlBefore);

  const href = new URL(opened[0]!);
  expect(href.origin).toBe(window.location.origin);
  fireEvent.click(button);
  expect(window.location.pathname).toBe(href.pathname);
  return href.pathname;
}

describe("openPane.link: the URL is where the plain click goes", () => {
  it("root", () => {
    const button = mount(
      [{ paneId: "lnk-conv", params: { convId: "7" } }],
      (open) => open.link(itemPane, { itemId: "I1" }, { mode: "root" }),
      0,
    );
    expect(expectLinkMatchesClick(button)).toBe("/lnk/list/item/I1");
  });

  it("push right truncates after the caller", () => {
    const button = mount(
      [
        { paneId: "lnk-conv", params: { convId: "7" } },
        { paneId: "lnk-plain", params: {} },
      ],
      (open) => open.link(itemPane, { itemId: "I1" }, { mode: "push" }),
      0,
    );
    expect(expectLinkMatchesClick(button)).toBe("/lnk/c/7/item/I1");
  });

  it("push left inserts ahead of the caller", () => {
    const button = mount(
      [{ paneId: "lnk-conv", params: { convId: "7" } }],
      (open) => open.link(plainPane, {}, { mode: "push", side: "left" }),
      0,
    );
    expect(expectLinkMatchesClick(button)).toBe("/lnk/plain/c/7");
  });

  it("push left at an existing ancestor falls through to the right", () => {
    const button = mount(
      [
        { paneId: "lnk-plain", params: {} },
        { paneId: "lnk-conv", params: { convId: "7" } },
      ],
      (open) => open.link(plainPane, {}, { mode: "push", side: "left" }),
      1,
    );
    expect(expectLinkMatchesClick(button)).toBe("/lnk/plain/c/7/plain");
  });

  it("a no-op swap links to the route already on screen", () => {
    const button = mount(
      [
        { paneId: "lnk-conv", params: { convId: "7" } },
        { paneId: "lnk-item", params: { itemId: "I1" } },
      ],
      (open) => open.link(itemPane, { itemId: "I1" }, { mode: "swap" }),
      1,
    );
    const before = store.getRoute();
    expect(expectLinkMatchesClick(button)).toBe("/lnk/c/7/item/I1");
    expect(store.getRoute()).toBe(before);
  });

  it("append with no caller lands after the last pane", () => {
    const button = mount(
      [
        { paneId: "lnk-conv", params: { convId: "7" } },
        { paneId: "lnk-plain", params: {} },
      ],
      (open) => open.link(itemPane, { itemId: "I1" }, { mode: "append" }),
    );
    expect(expectLinkMatchesClick(button)).toBe("/lnk/c/7/plain/item/I1");
  });

  it("append ignores the caller's position", () => {
    const button = mount(
      [
        { paneId: "lnk-conv", params: { convId: "7" } },
        { paneId: "lnk-plain", params: {} },
      ],
      (open) => open.link(itemPane, { itemId: "I1" }, { mode: "append" }),
      0,
    );
    expect(expectLinkMatchesClick(button)).toBe("/lnk/c/7/plain/item/I1");
  });

  it("append replaces a last pane of the same kind", () => {
    const button = mount(
      [
        { paneId: "lnk-conv", params: { convId: "7" } },
        { paneId: "lnk-item", params: { itemId: "I1" } },
      ],
      (open) => open.link(itemPane, { itemId: "I2" }, { mode: "append" }),
    );
    expect(expectLinkMatchesClick(button)).toBe("/lnk/c/7/item/I2");
  });

  it("append of the pane already last is a no-op", () => {
    const button = mount(
      [
        { paneId: "lnk-conv", params: { convId: "7" } },
        { paneId: "lnk-item", params: { itemId: "I1" } },
      ],
      (open) => open.link(itemPane, { itemId: "I1" }, { mode: "append" }),
    );
    const before = store.getRoute();
    expect(expectLinkMatchesClick(button)).toBe("/lnk/c/7/item/I1");
    expect(store.getRoute()).toBe(before);
  });

  it("no caller pane: a non-positional open", () => {
    const button = mount(
      [
        { paneId: "lnk-conv", params: { convId: "7" } },
        { paneId: "lnk-item", params: { itemId: "I1" } },
      ],
      (open) => open.link(itemPane, { itemId: "I2" }, { mode: "push" }),
    );
    expect(expectLinkMatchesClick(button)).toBe("/lnk/c/7/item/I2");
  });

  it("a caller no longer in the route: a non-positional open", () => {
    store.restoreRoute([{ paneId: "lnk-conv", params: { convId: "7" } }]);
    const gone = store.getRoute()[0]!.instanceId;
    const button = (() => {
      store.restoreRoute([{ paneId: "lnk-plain", params: {} }]);
      const view = render(
        <TestSurface store={store} plugins={plugins} basePath="/lnk">
          <PaneInstanceContext.Provider value={gone}>
            <LinkButton
              props={(open) =>
                open.link(itemPane, { itemId: "I1" }, { mode: "push" })
              }
            />
          </PaneInstanceContext.Provider>
        </TestSurface>,
      );
      return view.getByRole("button");
    })();
    expect(expectLinkMatchesClick(button)).toBe("/lnk/list/item/I1");
  });
});

describe("computeOpen", () => {
  it("reports an unchanged open as such, with the current route", () => {
    store.restoreRoute([
      { paneId: "lnk-conv", params: { convId: "7" } },
      { paneId: "lnk-item", params: { itemId: "I1" } },
    ]);
    const route = store.getRoute();
    const next = computeOpen(
      route,
      route[1]!.instanceId,
      itemPane._internal,
      { itemId: "I1" },
      { mode: "swap" },
    );
    expect(next.changed).toBe(false);
    expect(next.route).toBe(route);
  });

  it("is pure: computing an open writes nothing", () => {
    store.restoreRoute([{ paneId: "lnk-conv", params: { convId: "7" } }]);
    const route = store.getRoute();
    const url = window.location.pathname;
    const next = computeOpen(
      route,
      route[0]!.instanceId,
      plainPane._internal,
      {},
      { mode: "push" },
    );
    expect(next.changed).toBe(true);
    expect(store.getRoute()).toBe(route);
    expect(window.location.pathname).toBe(url);
    expect(store.routeUrl(next.route)).toBe("/lnk/c/7/plain");
  });
});

describe("Expand (re-root) is a link too", () => {
  function PromoteButton({ pane }: { pane: typeof itemPane }) {
    const promote = pane.usePromote();
    if (!promote) return null;
    return (
      <button type="button" {...linkProps(promote)}>
        expand
      </button>
    );
  }

  it("links to the route the re-root produces", () => {
    store.restoreRoute([
      { paneId: "lnk-conv", params: { convId: "7" } },
      { paneId: "lnk-item", params: { itemId: "I1" } },
    ]);
    const item = store.getRoute()[1]!;
    const view = render(
      <TestSurface store={store} plugins={plugins} basePath="/lnk">
        <PaneInstanceContext.Provider value={item.instanceId}>
          <PromoteButton pane={itemPane} />
        </PaneInstanceContext.Provider>
      </TestSurface>,
    );
    expect(expectLinkMatchesClick(view.getByRole("button"))).toBe(
      "/lnk/list/item/I1",
    );
  });
});
