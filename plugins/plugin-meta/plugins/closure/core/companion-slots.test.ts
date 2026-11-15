import { test, expect } from "bun:test";
import type {
  PluginNode,
  PluginTreeData,
} from "@plugins/plugin-meta/plugins/plugin-tree/core";
import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { slotsFacetDef } from "@plugins/plugin-meta/plugins/facets/plugins/slots/core";
import type { SlotDef } from "@plugins/plugin-meta/plugins/facets/plugins/slots/core";
import { contributionsFacetDef } from "@plugins/plugin-meta/plugins/facets/plugins/contributions/core";
import type {
  Contribution,
  ContributionsFacetData,
} from "@plugins/plugin-meta/plugins/facets/plugins/contributions/core";
import { collectCompanionSlots } from "./companion-slots";

function node(
  path: string,
  slots: SlotDef[],
  contributions: Contribution[],
): PluginNode {
  const data = {
    static: contributions,
    runtime: [],
    panes: [],
    routes: [],
    paneRefs: {},
    serverCompanionKinds: [],
    serverCompanions: [],
  } as unknown as ContributionsFacetData;
  return {
    dir: asAppPath(`/repo/plugins/${path}`),
    path,
    name: path.split("/").at(-1)!,
    id: asPluginId(path.replaceAll("/plugins/", ".")),
    descriptions: {},
    loadBearing: false,
    collapsed: false,
    compositionRoot: false,
    runtimes: { web: true, server: false, central: false, core: false },
    children: [],
    facets: { [slotsFacetDef.id]: slots, [contributionsFacetDef.id]: data },
  } as unknown as PluginNode;
}

function treeOf(...nodes: PluginNode[]): PluginTreeData {
  return {
    pluginsRoot: asAppPath("/repo/plugins"),
    byDir: new Map(nodes.map((n) => [n.dir, n])),
    byPath: new Map(nodes.map((n) => [n.path, n])),
    roots: nodes,
  };
}

const openSlot: SlotDef = {
  memberName: "Section",
  slotId: "owner.section",
  groupName: "Pane",
  companions: true,
  contributors: [],
};

test("a companion of a slot group no plugin declares throws, naming the file and group", () => {
  const tree = treeOf(
    node("owner", [openSlot], []),
    node(
      "contributor",
      [],
      [{ slot: "Unread.Section", props: {}, companion: true }],
    ),
  );
  expect(() => collectCompanionSlots(tree)).toThrow(
    /plugins\/contributor\/web\/index\.ts: `Unread\.Section\(\{ …, companion: true \}\)`.*slot group `Unread`/,
  );
});

test("a companion of a known slot is collected; one to its own slot is not", () => {
  const tree = treeOf(
    node(
      "owner",
      [openSlot],
      [{ slot: "Pane.Section", props: {}, companion: true }],
    ),
    node(
      "contributor",
      [],
      [{ slot: "Pane.Section", props: {}, companion: true }],
    ),
  );
  const [slot] = collectCompanionSlots(tree);
  expect(slot?.companions).toEqual([{ plugin: asPluginId("contributor") }]);
});

test("an unflagged contribution to an unknown group is not a companion error", () => {
  const tree = treeOf(
    node("contributor", [], [{ slot: "Unread.Section", props: {} }]),
  );
  expect(collectCompanionSlots(tree)).toEqual([]);
});
