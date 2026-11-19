// A loop's report names only a component its node renders under. The
// profiling window opens AFTER detection and is shared by every loop firing in
// it: report-1795066621-e79qiw, a rebuild under the demo page's pane, was
// "re-rendered by LiveDemoSection" — the homepage section that re-rendered
// while the visitor, back on the homepage, sat in the window. Nothing the
// demo page drew renders under it.

import { describe, expect, it } from "vitest";
import type { RenderLoopInitiator } from "../../core";
import {
  scopeAttribution,
  type Attribution,
} from "../internal/render-loop-detector";

function initiator(
  component: string,
  commitsPerSec: number,
): RenderLoopInitiator {
  return { component, ancestors: [], hooks: ["state#2"], commitsPerSec };
}

function window(above: Record<string, string[]>): Attribution {
  return {
    reactCommitsPerSec: 30,
    initiators: [initiator("LiveDemoSection", 20), initiator("HintHost", 8)],
    componentsAbove: (node) => above[(node as Element).id] ?? null,
  };
}

function attached(id: string): Element {
  const el = document.createElement("div");
  el.id = id;
  document.body.append(el);
  return el;
}

describe("scopeAttribution", () => {
  it("drops a busier initiator the node does not render under", () => {
    const node = attached("loop");
    const scoped = scopeAttribution(
      window({ loop: ["AppShellLayout", "HintHost", "DemoPage"] }),
      node,
    );
    expect(scoped?.initiators.map((i) => i.component)).toEqual(["HintHost"]);
    expect(scoped?.gone).toBe(false);
    node.remove();
  });

  it("names nothing when no initiator is above the node", () => {
    const node = attached("loop");
    const scoped = scopeAttribution(window({ loop: ["DemoPage"] }), node);
    expect(scoped?.initiators).toEqual([]);
    node.remove();
  });

  it("names nothing for a node that left the page before the window closed", () => {
    const node = document.createElement("div");
    node.id = "loop";
    const scoped = scopeAttribution(
      window({ loop: ["LiveDemoSection"] }),
      node,
    );
    expect(scoped).toMatchObject({ gone: true, initiators: [] });
  });
});
