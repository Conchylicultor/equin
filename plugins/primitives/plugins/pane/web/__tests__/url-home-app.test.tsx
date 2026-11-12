import { beforeAll, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import {
  Pane,
  parseUrl,
  useSyncPaneRegistry,
} from "@plugins/primitives/plugins/pane/web";
import { defineApp, defineRoute } from "@plugins/primitives/plugins/pane/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

// THE BASE PATH NAMES THE APP A URL IS IN.
//
// A URL is matched against every app's panes (a guest pane may sit beside a
// host's), and the longest match used to win outright — so a single pane of
// another app spanning the same parts as a chain of the app's own (Demo's
// `at/:url*` over Files' `at/:dir`, loaded cold at `/files/at/~`) headed the
// route, and the tab was carried off to the other app. Two segments that match
// the same URL are a registration error (`segmentCollision`); a CHAIN of the
// app's own panes against one foreign pane is not, so the parser itself must
// prefer the app the base path names.

const filesApp = defineApp({
  id: "url-home-files",
  name: "Files fixture",
  basePath: "/files",
  icon: symbol("folder"),
});
const otherApp = defineApp({
  id: "url-home-other",
  name: "Other fixture",
  basePath: "/other",
  icon: symbol("science"),
});

const folderRoute = defineRoute({ id: "uh-folder", segment: "at/:dir" });
const folderPane = Pane.define({
  route: folderRoute,
  app: filesApp,
  useResolve: false,
  component: () => null,
});
const previewPane = Pane.define({
  route: defineRoute({
    id: "uh-preview",
    segment: "preview/:open",
    parent: folderRoute,
  }),
  app: filesApp,
  useResolve: false,
  component: () => null,
});
/** One foreign pane spanning exactly what the folder + preview chain spans. */
const foreignPane = Pane.define({
  route: defineRoute({ id: "uh-foreign", segment: "at/:a/preview/:b" }),
  app: otherApp,
  useResolve: false,
  component: () => null,
});

const plugins = [
  {
    id: "url-home-app-test-plugin",
    description: "base-path app preference fixture",
    contributions: [
      // The foreign pane first: registry order is the equal-length tie-break,
      // so it would win any tie the base path did not decide.
      Pane.Register({ pane: foreignPane }),
      Pane.Register({ pane: folderPane }),
      Pane.Register({ pane: previewPane }),
    ],
  } as unknown as LoadedPlugin,
];

function RegistrySync() {
  useSyncPaneRegistry();
  return null;
}

beforeAll(() => {
  render(
    <PluginProvider plugins={plugins}>
      <RegistrySync />
    </PluginProvider>,
  );
  cleanup();
});

function parsed(path: string, basePath: string) {
  const r = parseUrl(path, basePath);
  if (r.status === "unresolved") return "unresolved";
  return r.slots.map((s) => s.paneId);
}

describe("parseUrl prefers the app its base path names", () => {
  it("keeps a URL under /files on Files' own chain, though a foreign pane matches more of it", () => {
    expect(parsed("/at/~/preview/x", "/files")).toEqual([
      "uh-folder",
      "uh-preview",
    ]);
  });

  it("gives the same URL under the other app to that app's pane", () => {
    expect(parsed("/at/~/preview/x", "/other")).toEqual(["uh-foreign"]);
  });

  it("still lets another app's pane head a URL the app's own panes cannot parse", () => {
    // A stale or typed URL: TabsProvider then moves the tab to its app.
    expect(parsed("/at/~/preview/x", "/elsewhere")).toEqual(["uh-foreign"]);
  });

  it("ignores a trailing slash on the base path", () => {
    expect(parsed("/at/~/preview/x", "/files/")).toEqual([
      "uh-folder",
      "uh-preview",
    ]);
  });
});
