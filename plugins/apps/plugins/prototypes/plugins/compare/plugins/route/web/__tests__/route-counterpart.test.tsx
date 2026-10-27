import { describe, expect, it } from "vitest";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { Apps } from "@plugins/apps-core/web";
import {
  renderWithTransport,
  testTransport,
} from "@plugins/primitives/plugins/networking/web/testing";
import type { CounterpartResolution } from "@plugins/apps/plugins/prototypes/plugins/compare/web";
import type { PrototypeMeta } from "@plugins/apps/plugins/prototypes/plugins/files/core";
import {
  RouteCounterpart,
  WholeAppCounterpart,
} from "../components/route-counterpart";

/** The app registry's slot, with no app contributed. */
const plugin = {
  id: "route-counterpart-test",
  description: "route counterpart fixture",
  contributions: [],
  slots: Apps,
} as unknown as LoadedPlugin;

/** The prototype declaring the counterpart (the app kinds never read it). */
const META: PrototypeMeta = {
  name: "proto-1789000000-abcd",
  rev: "r1",
  createdAt: Date.UTC(2026, 0, 1),
  modifiedAt: Date.UTC(2026, 0, 2),
  title: "Agents",
  blurb: "",
  viewport: { kind: "responsive" },
  mocks: { kind: "none" },
  options: [],
  problems: [],
};

/** What a kind answers for `target` under a transport serving `servesUrls`. */
function resolutionOf(
  Kind: typeof RouteCounterpart,
  target: string,
  servesUrls: boolean,
): CounterpartResolution {
  const seen: CounterpartResolution[] = [];
  renderWithTransport(
    <PluginProvider plugins={[plugin]}>
      <Kind kind="route" target={target} meta={META}>
        {(resolution) => {
          seen.push(resolution);
          return null;
        }}
      </Kind>
    </PluginProvider>,
    { transport: testTransport({ servesUrls }) },
  );
  const last = seen.at(-1);
  if (last === undefined) throw new Error("the kind rendered no resolution");
  return last;
}

describe("app counterparts under a transport no URL reaches", () => {
  it.each([
    ["route:", RouteCounterpart],
    ["app:", WholeAppCounterpart],
  ] as const)("%s answers unresolved, framing nothing", (_, Kind) => {
    const resolution = resolutionOf(Kind, "/agents", false);
    expect(resolution.status).toBe("unresolved");
    if (resolution.status !== "unresolved") return;
    expect(resolution.title).toBe(
      "The real app frame needs the app served by URL.",
    );
  });

  it("still resolves past the URL gate on the page's own server", () => {
    // No app is registered in this test, so the page's server gets as far as
    // the app lookup — a different unresolved answer than the URL gate's.
    const resolution = resolutionOf(RouteCounterpart, "/agents", true);
    expect(resolution.status).toBe("unresolved");
    if (resolution.status !== "unresolved") return;
    expect(resolution.title).not.toBe(
      "The real app frame needs the app served by URL.",
    );
  });
});
