import { describe, it, expect } from "bun:test";
import {
  formatLineageNode,
  formatLineagePath,
  lineageNodeIdentity,
  parseLineageNode,
  parseLineagePath,
  type LineageNode,
} from "./node";

// One of every shape the formatter can emit — a contribution with and without a
// slot, and a region with every combination of optional plugin/label.
const NODES: LineageNode[] = [
  { kind: "contribution", pluginId: "apps-core.tab-bar", slotId: "apps.tab-bar" },
  { kind: "contribution", pluginId: "improve" },
  {
    kind: "region",
    regionKind: "pane",
    id: "deploy-deployment-detail",
    label: "column 3 of 3",
    pluginId: "apps.deploy.deployments",
  },
  { kind: "region", regionKind: "pane", id: "sonata-player" },
  { kind: "region", regionKind: "window", id: "w-1", label: "window 2 of 2" },
  { kind: "region", regionKind: "tab", id: "t-7", pluginId: "apps.pages" },
];

describe("lineage path parse ⇄ format", () => {
  // The binding that matters: the parser is the formatter's inverse, so a
  // structured display can never spell the grammar differently from the writer.
  it.each(NODES)("round-trips a node through its formatted form", (node) => {
    expect(parseLineageNode(formatLineageNode(node))).toEqual(node);
  });

  it("round-trips a whole chain", () => {
    expect(parseLineagePath(formatLineagePath(NODES))).toEqual(NODES);
  });

  it("re-formats a real captured path byte-identically", () => {
    const path =
      "apps-core.tab-bar@apps.tab-bar > shell.global-action-bar@apps.tab-bar-actions > improve@action-bar.item > improve.element-picker@task-draft-form.action";
    expect(formatLineagePath(parseLineagePath(path))).toBe(path);
  });

  // Total by construction: a segment matching neither shape IS a plugin id.
  it("reads an unrecognized segment as a bare contribution", () => {
    expect(parseLineageNode("whatever this is")).toEqual({
      kind: "contribution",
      pluginId: "whatever this is",
    });
  });

  it("ignores empty segments", () => {
    expect(parseLineagePath("")).toEqual([]);
  });
});

describe("lineageNodeIdentity", () => {
  it("drops a region's label and keeps everything else", () => {
    const at = (label?: string) =>
      lineageNodeIdentity(
        parseLineageNode(`pages/page#pane:page${label ? `[${label}]` : ""}`),
      );
    expect(at("column 2 of 2")).toBe("pages/page#pane:page");
    expect(at("column 2 of 3")).toBe(at("column 2 of 2"));
    expect(at()).toBe(at("column 1 of 1"));
    expect(
      lineageNodeIdentity(parseLineageNode("pages/page#pane:other")),
    ).not.toBe(at());
  });

  it("is the formatted node for a contribution", () => {
    const n = parseLineageNode("pages/share@PaneToolbar.Item");
    expect(lineageNodeIdentity(n)).toBe(formatLineageNode(n));
  });
});
