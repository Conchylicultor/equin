import { useContext, useLayoutEffect, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

import type { LoadedPlugin } from "@plugins/framework/plugins/web-sdk/core";
import {
  Pane,
  PaneBasePathContext,
  usePaneMatch,
  type PaneStore,
} from "@plugins/primitives/plugins/pane/web";
import { defineApp, defineRoute } from "@plugins/primitives/plugins/pane/core";
import { createTestSurfaceStore, TestSurface } from "../testing";
import { symbol } from "@plugins/ui/plugins/icons/core";

// AN APP SWITCH NEVER DRAWS THE OLD APP'S PANES UNDER THE NEW SHELL.
//
// The surface shows its match deferred (a navigation keeps the previous panes
// until the new ones can draw). An app switch in one tab keeps the surface's
// store and provider and changes only its base path — and the new app's shell
// renders at once, from that base path. Had the deferred match been shown
// across the switch, one commit would draw the OLD app's panes under the NEW
// app's shell, whose providers they cannot read: Sonata's player under the
// Agent Manager shell, the site's live-demo page under Sonata's — each a
// "scoped-store: hook used outside its <Provider>" crash (2026-11-18, on
// equin.ai's home page too). This suite records every commit's (base path,
// matched panes' apps) pair and pins that they never disagree.

const appA = defineApp({
  id: "switch-a",
  name: "Switch A",
  basePath: "/switch-a",
  icon: symbol("science"),
});
const appB = defineApp({
  id: "switch-b",
  name: "Switch B",
  basePath: "/switch-b",
  icon: symbol("science"),
});

const paneA = Pane.define({
  route: defineRoute({ id: "switch-a-page", segment: "a-page" }),
  app: appA,
  component: () => null,
});
const paneB = Pane.define({
  route: defineRoute({ id: "switch-b-page", segment: "b-page" }),
  app: appB,
  component: () => null,
});

const plugins = [
  {
    id: "switch-test-plugin",
    description: "app-switch-match test fixture",
    contributions: [
      Pane.Register({ pane: paneA }),
      Pane.Register({ pane: paneB }),
    ],
  } as unknown as LoadedPlugin,
];

const homeOf: Record<string, string> = {
  [paneA.id]: appA.basePath,
  [paneB.id]: appB.basePath,
};

/** Records, at every commit, the surface's base path and its panes' homes. */
function CommitProbe({ commits }: { commits: string[][] }): ReactNode {
  const basePath = useContext(PaneBasePathContext);
  const homes = (usePaneMatch()?.panes ?? []).map(
    (e) => homeOf[e.pane.id] ?? "unknown",
  );
  useLayoutEffect(() => {
    commits.push([basePath, ...homes]);
  });
  return null;
}

function mount(store: PaneStore, basePath: string, commits: string[][]) {
  return (
    <TestSurface store={store} basePath={basePath} plugins={plugins}>
      <CommitProbe commits={commits} />
    </TestSurface>
  );
}

afterEach(cleanup);

describe("an app switch in one surface", () => {
  it("never commits the previous app's panes under the new base path", async () => {
    const store = createTestSurfaceStore({ live: false });
    const commits: string[][] = [];
    store.restoreRoute([{ paneId: paneA.id, params: {} }]);
    const view = render(mount(store, appA.basePath, commits));
    expect(commits.at(-1)).toEqual([appA.basePath, appA.basePath]);

    // The tabs layer's switch: the same store gets the new app's route, and
    // the surface its base path, in one update.
    await act(async () => {
      store.restoreRoute([{ paneId: paneB.id, params: {} }]);
      view.rerender(mount(store, appB.basePath, commits));
    });

    for (const [basePath, ...homes] of commits) {
      for (const home of homes) expect(home).toBe(basePath);
    }
    expect(commits.at(-1)).toEqual([appB.basePath, appB.basePath]);
  });
});
