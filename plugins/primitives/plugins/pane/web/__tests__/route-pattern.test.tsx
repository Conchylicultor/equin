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
import { routePatternOf } from "../pane";
import { defineApp, defineRoute } from "@plugins/primitives/plugins/pane/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

// A ROUTE PATTERN IS AS SHORT AS THE CODE THAT DECLARES IT.
//
// Per-screen telemetry (the latency ledger) groups by the route pattern: the
// app's base path and each pane's declared positional segment — never the ids,
// keyed params or DataView filters the address bar carries, which can be any
// length (a base64 filter blob once made every latency batch of the tab a 400).

const app = defineApp({
  id: "route-pattern-app",
  name: "Route pattern test app",
  basePath: "/deploy",
  icon: symbol("science"),
});

const siteRoute = defineRoute({
  id: "rp-site",
  segment: "site/:deploymentId/:tab?;page",
});
const sitePane = Pane.define({
  route: siteRoute,
  app,
  useResolve: false,
  component: () => null,
});
const replayRoute = defineRoute({
  id: "rp-replay",
  segment: "replay/:visitId",
});
const replayPane = Pane.define({
  route: replayRoute,
  app,
  useResolve: false,
  component: () => null,
});

const plugins = [
  {
    id: "route-pattern-test-plugin",
    description: "route pattern fixture",
    contributions: [
      Pane.Register({ pane: sitePane }),
      Pane.Register({ pane: replayPane }),
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

function patternOf(path: string): string {
  const r = parseUrl(path, "/deploy");
  if (r.status === "unresolved") throw new Error(`unresolved: ${path}`);
  return routePatternOf("/deploy", r.slots);
}

describe("routePatternOf", () => {
  it("drops ids, keyed params and a long DataView filter", () => {
    const filter = "A".repeat(2_000);
    const path = `/site/dep-123/sessions;page=x;view.deploy-sessions=all~${filter}/replay/v-9`;
    expect(patternOf(path)).toBe(
      "/deploy/site/:deploymentId/:tab?/replay/:visitId",
    );
  });

  it("is the same pattern whatever record the screen shows", () => {
    expect(patternOf("/site/a")).toBe(patternOf("/site/b/overview"));
  });

  it("is the app's root for the landing pane (an empty route)", () => {
    expect(routePatternOf("/deploy", [])).toBe("/deploy");
    expect(routePatternOf("/", [])).toBe("/");
  });

  it("throws on a pane the registry does not know", () => {
    expect(() => routePatternOf("/deploy", [{ paneId: "nope" }])).toThrow(
      "Unknown pane: nope",
    );
  });
});
