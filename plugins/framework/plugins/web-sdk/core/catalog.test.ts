import { describe, expect, it } from "bun:test";
import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import {
  factJson,
  type WebCatalog,
} from "@plugins/framework/plugins/list-catalog/core";
import type { ComponentType } from "react";
import { createPluginRegistry } from "./registry";
import { defineRootSlot, defineSlot } from "./slots";
import { catalogMismatches } from "./catalog";
import type { Contribution, LoadedPlugin } from "./types";

const Root = defineRootSlot();
const Labels = defineSlot<{ label: string; component: ComponentType }>();
const Nothing: ComponentType = () => null;

function plugin(
  id: string,
  contributions: Contribution[],
  slots?: Record<string, unknown>,
): LoadedPlugin {
  return {
    id: asPluginId(id),
    description: id,
    contributions,
    ...(slots ? { slots } : {}),
  } as LoadedPlugin;
}

const owner = plugin("owner", [], { root: Root, labels: Labels });
const LISTS: WebCatalog["lists"] = [
  // web-sdk's own lists: every registry declares them (its seed).
  ...["root", "boot"].map((key) => ({
    id: `framework.web-sdk.${key}`,
    plugin: "framework.web-sdk",
    key,
    meta: { kind: "slot" as const, reorderable: false },
    inMain: true,
  })),
  {
    id: "owner.root",
    plugin: "owner",
    key: "root",
    meta: { kind: "slot", reorderable: false, companions: true },
    inMain: true,
  },
  {
    id: "owner.labels",
    plugin: "owner",
    key: "labels",
    meta: { kind: "slot", reorderable: false },
    inMain: true,
  },
];

/** What the build writes for `c` (the same rule, `factJson`). */
function entry(list: string, pluginId: string, c: Contribution) {
  return {
    list,
    plugin: pluginId,
    fact: JSON.parse(factJson(c, "entry")) as Record<string, unknown>,
  };
}

const noStep = () => Promise.resolve();
const all = () => true;

describe("catalogMismatches", () => {
  it("is empty when the loaded plugins declare what the catalog holds", async () => {
    const companion = Root({
      component: Nothing,
      companion: true,
      scope: "page",
    });
    const label = Labels({ label: "A", component: Nothing });
    const registry = createPluginRegistry();
    registry.append([owner, plugin("c1", [companion]), plugin("l1", [label])]);
    const catalog: WebCatalog = {
      lists: LISTS,
      entries: [
        entry("owner.root", "c1", companion),
        entry("owner.labels", "l1", label),
      ],
      companionProviders: { "owner.root": [{ plugin: "c1" }] },
    };
    expect(await catalogMismatches(registry, catalog, all, noStep)).toEqual([]);
  });

  it("names an entry of a page plugin that never loaded (a missing companion)", async () => {
    const companion = Root({
      component: Nothing,
      companion: true,
      scope: "page",
    });
    const registry = createPluginRegistry();
    registry.append([owner]);
    const catalog: WebCatalog = {
      lists: LISTS,
      entries: [entry("owner.root", "c1", companion)],
      companionProviders: { "owner.root": [{ plugin: "c1" }] },
    };
    const problems = await catalogMismatches(registry, catalog, all, noStep);
    expect(problems).toEqual([
      expect.stringContaining('c1 adds 1 entry to "owner.root"'),
    ]);
    // An on-demand plugin not loaded yet is a wait, not a loss.
    expect(
      await catalogMismatches(registry, catalog, () => false, noStep),
    ).toEqual([]);
  });

  it("names an entry whose fact differs from what the build wrote", async () => {
    const registry = createPluginRegistry();
    registry.append([
      owner,
      plugin("l1", [Labels({ label: "at run time", component: Nothing })]),
    ]);
    const catalog: WebCatalog = {
      lists: LISTS,
      entries: [
        entry(
          "owner.labels",
          "l1",
          Labels({ label: "at build time", component: Nothing }),
        ),
      ],
      companionProviders: {},
    };
    expect(await catalogMismatches(registry, catalog, all, noStep)).toEqual([
      expect.stringContaining('"owner.labels" entries of l1 differ'),
    ]);
  });

  it("names a declared list the catalog does not hold (a stale catalog)", async () => {
    const registry = createPluginRegistry();
    registry.append([owner]);
    const problems = await catalogMismatches(
      registry,
      {
        lists: LISTS.filter((l) => l.id !== "owner.labels"),
        entries: [],
        companionProviders: {},
      },
      all,
      noStep,
    );
    expect(problems).toEqual([
      expect.stringContaining('list "owner.labels" (owner) is declared'),
    ]);
  });

  it("names a companion the repo provides that this page does not ship (a closure bug)", async () => {
    const registry = createPluginRegistry();
    registry.append([owner]);
    const catalog: WebCatalog = {
      lists: LISTS,
      // Not in this page's entries — another composition's plugin.
      entries: [],
      companionProviders: { "owner.root": [{ plugin: "elsewhere" }] },
    };
    expect(await catalogMismatches(registry, catalog, all, noStep)).toEqual([
      expect.stringContaining("needs its companion elsewhere"),
    ]);
  });
});
