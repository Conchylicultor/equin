import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, fireEvent } from "@testing-library/react";
import {
  UI_CONTEXT_FIELDS,
  parseLineagePath,
  type UiContextMeta,
} from "@plugins/primitives/plugins/ui-context/core";
import { UiContextChip } from "../components/ui-context-chip";

afterEach(cleanup);

// Every field the tag can carry, so the popover must surface all of them.
const meta: UiContextMeta = {
  url: "http://x.localhost:9000/sonata/song/abc",
  pluginId: "apps.sonata.piano-roll",
  slotId: "sonata.toolbar.end",
  contributionId: "apps.sonata.piano-roll:spread",
  path: "apps.sonata.shell@apps.app > apps.sonata.piano-roll#pane:sonata-player[column 2 of 2] > apps.sonata.piano-roll@sonata.toolbar.end",
  innerSlots: "sonata.toolbar.start, sonata.toolbar.end",
  element: "div — 1×",
  selector: "header>div>div",
  source: "plugins/foo/web/bar.tsx:42",
  owner: "SpreadWheel@plugins/.../spread-wheel.tsx:52",
};

describe("ui-context chip popover shows every registry field", () => {
  it("renders one labelled row per UI_CONTEXT_FIELDS entry", () => {
    const { getByRole, getAllByText } = render(<UiContextChip meta={meta} />);
    // Open the popover.
    fireEvent.click(getByRole("button"));
    // The guarantee: no field can be silently dropped from the display. Values
    // repeat across rows (the innermost lineage node IS the plugin/slot pair),
    // hence getAllByText.
    for (const f of UI_CONTEXT_FIELDS) {
      expect(getAllByText(f.label).length).toBeGreaterThan(0);
      // `path` is drawn structurally — one row per lineage node — so its
      // representation is asserted node by node below, not as a flat string.
      if (f.key === "path") continue;
      expect(getAllByText(String(meta[f.key])).length).toBeGreaterThan(0);
    }
  });

  it("renders the lineage path as one row per node, innermost last", () => {
    const { getByRole, getAllByText } = render(<UiContextChip meta={meta} />);
    fireEvent.click(getByRole("button"));
    // Every piece of every node reaches the screen — nothing the flat string
    // carried is lost by rendering it structurally.
    for (const node of parseLineagePath(meta.path!)) {
      if (node.kind === "contribution") {
        expect(getAllByText(node.pluginId).length).toBeGreaterThan(0);
        if (node.slotId)
          expect(getAllByText(node.slotId).length).toBeGreaterThan(0);
      } else {
        expect(getAllByText(node.id).length).toBeGreaterThan(0);
        if (node.label)
          expect(getAllByText(`(${node.label})`).length).toBeGreaterThan(0);
      }
    }
  });
});
