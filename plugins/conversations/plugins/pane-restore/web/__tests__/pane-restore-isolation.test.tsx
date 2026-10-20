import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import {
  createPaneStore,
  Pane,
  setLiveStore,
  useSyncPaneRegistry,
} from "@plugins/primitives/plugins/pane/web";
import { defaultStore } from "@plugins/primitives/plugins/pane/web/testing";
import { defineRoute } from "@plugins/primitives/plugins/pane/core";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
// Importing the barrel registers the module-load popstate/shell:navigate
// listener (`import "./internal/pane-restore-store"`) and exposes the reader.
import { loadRouteForConversation } from "@plugins/conversations/plugins/pane-restore/web";

// Proves the pane-restore save listener does not cross-contaminate between tabs.
// It reads the focused (live) store's route AND its conversation key from the
// same `peekRoute()` snapshot, so the persisted entry for a conversation always
// reflects that conversation's own route — switching the focused tab to a second
// conversation never clobbers the first.

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Register the panes the conversation route uses so a live `setRoute` (which the
// save listener observes) can build its URL. `conversation` matches the id the
// listener gates on (`route[0].paneId === "conversation"`).
const conversationRoute = defineRoute({
  id: "conversation",
  segment: "c/:convId",
});
const conversationPaneDef = Pane.define({
  route: conversationRoute,
  app: agentManagerApp,
  useResolve: false,
  component: () => null,
});
const fileRoute = defineRoute({ id: "file-pane", segment: "f/:path" });
const filePaneDef = Pane.define({
  route: fileRoute,
  app: agentManagerApp,
  useResolve: false,
  component: () => null,
});

const testPlugin = {
  id: "pane-restore-test-plugin",
  description: "pane-restore test fixture",
  contributions: [
    Pane.Register({ pane: conversationPaneDef }),
    Pane.Register({ pane: filePaneDef }),
  ],
} as unknown as LoadedPlugin;

function RegistrySync() {
  useSyncPaneRegistry();
  return null;
}

beforeAll(() => {
  render(
    <PluginProvider plugins={[testPlugin]}>
      <RegistrySync />
    </PluginProvider>,
  );
  cleanup();
});

function clearSavedRoutes(): void {
  for (const convId of ["X", "Y"])
    localStorage.removeItem("s:conversations.pane-restore:" + convId);
}

beforeEach(() => {
  clearSavedRoutes();
  setLiveStore(defaultStore);
});

afterEach(() => {
  clearSavedRoutes();
  setLiveStore(defaultStore);
});

describe("pane-restore save listener", () => {
  it("persists each conversation's route under its own key, with no cross-tab clobber", async () => {
    // Tab A — conversation X. A live restoreRoute writes history + dispatches
    // the global shell:navigate the listener saves on.
    const tabA = createPaneStore({ live: true });
    setLiveStore(tabA);
    tabA.restoreRoute([{ paneId: "conversation", params: { convId: "X" } }]);
    await delay(90);

    expect(loadRouteForConversation("X")).toEqual({
      kind: "restored",
      slots: [{ paneId: "conversation", params: { convId: "X" }, options: {} }],
    });
    expect(loadRouteForConversation("Y")).toEqual({ kind: "none" });

    // Focus switches to Tab B — conversation Y with a deeper route.
    tabA.live = false;
    const tabB = createPaneStore({ live: true });
    setLiveStore(tabB);
    tabB.restoreRoute([
      { paneId: "conversation", params: { convId: "Y" } },
      { paneId: "file-pane", params: { path: "a.ts" } },
    ]);
    await delay(90);

    expect(loadRouteForConversation("Y")).toEqual({
      kind: "restored",
      slots: [
        { paneId: "conversation", params: { convId: "Y" }, options: {} },
        { paneId: "file-pane", params: { path: "a.ts" }, options: {} },
      ],
    });
    // X's persisted route is untouched by Tab B's navigation.
    expect(loadRouteForConversation("X")).toEqual({
      kind: "restored",
      slots: [{ paneId: "conversation", params: { convId: "X" }, options: {} }],
    });
  });
});

describe("pane-restore storage", () => {
  it("drops a corrupt entry (the store reports it) and reads as nothing to restore", () => {
    localStorage.setItem(
      "s:conversations.pane-restore:X",
      JSON.stringify({ ts: Date.now(), v: [{ nope: 1 }] }),
    );

    expect(loadRouteForConversation("X")).toEqual({ kind: "none" });
    expect(localStorage.getItem("s:conversations.pane-restore:X")).toBeNull();
  });
});
