import { describe, expect, test } from "bun:test";
import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import type { ConfigRegistration } from "@plugins/config_v2/web";
import { buildConfigTree, type ConfigTreeNode } from "./config-tree";
import { flattenConfigTree } from "./flatten-config-tree";

const reg = (pluginId: string, name = pluginId): ConfigRegistration => ({
  descriptor: {
    name,
    fields: {},
  } as unknown as ConfigRegistration["descriptor"],
  pluginId: asPluginId(pluginId),
  pluginName: pluginId.split(".").at(-1)!,
  storePath: `${pluginId.split(".").join("/")}/${name}.jsonc`,
});

const shape = (nodes: ConfigTreeNode[]): unknown =>
  nodes.map((n) => ({
    id: n.id,
    name: n.name,
    configs: n.registrations.map((r) => r.descriptor.name),
    children: shape(n.children),
  }));

describe("buildConfigTree", () => {
  test("nests each registration under its plugin id's prefixes, siblings by name", () => {
    const tree = buildConfigTree([
      reg("tasks.task-list"),
      reg("apps.sonata.metronome"),
      reg("apps"),
      reg("apps.chord"),
    ]);
    expect(shape(tree)).toEqual([
      {
        id: "apps",
        name: "apps",
        configs: ["apps"],
        children: [
          {
            id: "apps.chord",
            name: "chord",
            configs: ["apps.chord"],
            children: [],
          },
          {
            id: "apps.sonata",
            name: "sonata",
            configs: [],
            children: [
              {
                id: "apps.sonata.metronome",
                name: "metronome",
                configs: ["apps.sonata.metronome"],
                children: [],
              },
            ],
          },
        ],
      },
      {
        id: "tasks",
        name: "tasks",
        configs: [],
        children: [
          {
            id: "tasks.task-list",
            name: "task-list",
            configs: ["tasks.task-list"],
            children: [],
          },
        ],
      },
    ]);
  });

  test("a plugin with several configs keeps them all, and flattens to a header plus one row each", () => {
    const tree = buildConfigTree([reg("shell", "a"), reg("shell", "b")]);
    expect(tree[0]!.registrations.map((r) => r.descriptor.name)).toEqual([
      "a",
      "b",
    ]);
    const rows = flattenConfigTree(tree);
    expect(rows.map((r) => [r.id, r.parentId, r.label])).toEqual([
      ["shell", null, "shell"],
      ["shell::shell/a.jsonc", "shell", "a"],
      ["shell::shell/b.jsonc", "shell", "b"],
    ]);
    expect(rows[0]!.registration).toBeNull();
  });

  test("no registrations, no rows", () => {
    expect(buildConfigTree([])).toEqual([]);
  });
});
