import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ComponentType } from "react";
import {
  PluginProvider,
  type Contribution,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { defineRenderSlot } from "@plugins/primitives/plugins/slot-render/web";
import { ViewportOverlay } from "@plugins/primitives/plugins/css/plugins/viewport-overlay/web";
import {
  appendLineage,
  collectMeta,
  UiRegion,
} from "@plugins/primitives/plugins/ui-context/web";
import { parseLineage } from "@plugins/primitives/plugins/ui-context/web/testing";
import { PluginMarkerMiddleware } from "../internal/marker-middleware";
import { pickerPlugin } from "./picker-plugin";

afterEach(cleanup);

const appSlot = defineRenderSlot<{ component: ComponentType }>();

// A contribution that portals its content out to document.body — the popover /
// dialog / menu case from the bug report. ViewportOverlay is a real portal that
// re-stamps the forwarded `data-*` bag, so it stands in for any base-ui portal
// surface here without needing open-state plumbing.
function portaledContribution(): Contribution {
  return {
    _pluginId: "my.plugin",
    id: "my.contrib",
  } as unknown as Contribution;
}

describe("plugin lineage survives a portal", () => {
  it("resolves the owning plugin for an element portaled out of its slot", () => {
    render(
      <PluginMarkerMiddleware
        slotId="test.slot"
        contribution={portaledContribution()}
      >
        <ViewportOverlay>
          <button data-testid="target">Pick me</button>
        </ViewportOverlay>
      </PluginMarkerMiddleware>,
    );
    // The button is portaled to document.body, severed from the marker span.
    const target = document.querySelector<HTMLElement>(
      '[data-testid="target"]',
    )!;
    expect(target).not.toBeNull();

    const meta = collectMeta(target);
    expect(meta.pluginId).toBe("my.plugin");
    expect(meta.slotId).toBe("test.slot");
    expect(meta.contributionId).toBe("my.plugin:my.contrib");
  });

  it("regression: a portaled element with no bridge resolves no plugin", () => {
    // Same portal, but rendered *outside* any marker middleware — proves the
    // portal genuinely severs DOM ancestry, so the lineage attribute (not the
    // span) is what carries the owner across.
    render(
      <ViewportOverlay>
        <button data-testid="orphan">No owner</button>
      </ViewportOverlay>,
    );
    const orphan = document.querySelector<HTMLElement>(
      '[data-testid="orphan"]',
    )!;
    expect(collectMeta(orphan).pluginId).toBeUndefined();
  });

  it("carries the full outer→inner lineage as a path across the portal", () => {
    render(
      <PluginMarkerMiddleware
        slotId="outer.slot"
        contribution={{ _pluginId: "outer.plugin" } as unknown as Contribution}
      >
        <PluginMarkerMiddleware
          slotId="inner.slot"
          contribution={portaledContribution()}
        >
          <ViewportOverlay>
            <button data-testid="nested">Deep</button>
          </ViewportOverlay>
        </PluginMarkerMiddleware>
      </PluginMarkerMiddleware>,
    );
    const meta = collectMeta(
      document.querySelector<HTMLElement>('[data-testid="nested"]')!,
    );
    expect(meta.pluginId).toBe("my.plugin");
    expect(meta.path).toBe("outer.plugin@outer.slot > my.plugin@inner.slot");
  });

  it("mixes region and contribution nodes in one path across the portal", () => {
    // The cutover shape: a layout renderer wraps the pane in a region, a slot
    // contribution renders inside it, and the content portals out. The region
    // must survive the portal and sit in the chain exactly where it composed.
    render(
      <UiRegion
        kind="pane"
        id="deploy-deployment-detail"
        label="column 3 of 3"
        pluginId="apps/deploy/deployments"
      >
        <PluginMarkerMiddleware
          slotId="inner.slot"
          contribution={portaledContribution()}
        >
          <ViewportOverlay>
            <button data-testid="mixed">Deep</button>
          </ViewportOverlay>
        </PluginMarkerMiddleware>
      </UiRegion>,
    );
    const meta = collectMeta(
      document.querySelector<HTMLElement>('[data-testid="mixed"]')!,
    );
    expect(meta.path).toBe(
      "apps/deploy/deployments#pane:deploy-deployment-detail[column 3 of 3] > my.plugin@inner.slot",
    );
    // The headline still describes ONE node — the innermost contribution.
    expect(meta.pluginId).toBe("my.plugin");
    expect(meta.slotId).toBe("inner.slot");
  });

  it("reports the region's owning plugin (and no slot) for a pick in the pane's own markup", () => {
    // The (b) fix: without the region node the walk climbed past the pane to the
    // app shell's Apps.App contribution and reported the shell as the owner.
    //
    // Rendered through a REAL slot, not the middleware: the contribution node is
    // a DOM stamp on the box slot-render draws (the middleware only carries the
    // chain across portals), so DOM-ancestry cases have to compose the way the
    // app does.
    const plugin = {
      id: "apps.deploy.shell",
      description: "app shell fixture",
      contributions: [
        appSlot({
          id: "shell",
          component: () => (
            <UiRegion
              kind="pane"
              id="deploy-deployment-detail"
              label="column 3 of 3"
              pluginId="apps/deploy/deployments"
            >
              <button data-testid="in-pane">Overview</button>
            </UiRegion>
          ),
        }),
      ],
      // A rendered slot must be a declared slot — its id derives from here.
      slots: { app: appSlot },
    } as unknown as LoadedPlugin;
    render(
      <PluginProvider plugins={[pickerPlugin, plugin]}>
        <appSlot.Render />
      </PluginProvider>,
    );
    const meta = collectMeta(
      document.querySelector<HTMLElement>('[data-testid="in-pane"]')!,
    );
    expect(meta.pluginId).toBe("apps/deploy/deployments");
    expect(meta.slotId).toBeUndefined();
    expect(meta.contributionId).toBeUndefined();
    expect(meta.path).toBe(
      "apps.deploy.shell@apps.deploy.shell.app > apps/deploy/deployments#pane:deploy-deployment-detail[column 3 of 3]",
    );
  });
});

describe("lineage serialization", () => {
  it("round-trips nodes and skips owner-less contributions", () => {
    const a = appendLineage(undefined, {
      kind: "contribution",
      pluginId: "p1",
      slotId: "s1",
    });
    const b = appendLineage(a, {
      kind: "contribution",
      pluginId: "p2",
      slotId: "s2",
      contributionId: "p2:c",
    });
    // A contribution with no plugin id leaves the chain untouched.
    const c = appendLineage(b, {
      kind: "contribution",
      pluginId: "",
      slotId: "s3",
    });
    expect(c).toBe(b);
    expect(parseLineage(c)).toEqual([
      { kind: "contribution", pluginId: "p1", slotId: "s1" },
      {
        kind: "contribution",
        pluginId: "p2",
        slotId: "s2",
        contributionId: "p2:c",
      },
    ]);
  });

  it("parses an empty lineage to []", () => {
    expect(parseLineage(undefined)).toEqual([]);
  });
});
