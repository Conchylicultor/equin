import { describe, expect, it } from "bun:test";
import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import type { ComponentType } from "react";
import { createPluginRegistry } from "./registry";
import { defineRootSlot, defineSlot } from "./slots";
import { missingCompanions } from "./companions";
import type { Contribution, LoadedPlugin } from "./types";

// Declared under `ui.icons`'s real id and key, so the slot id matches the
// committed companion manifest, which lists its two companions.
const IconsRoot = defineRootSlot();
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

const owner = plugin("ui.icons", [], { root: IconsRoot });

describe("missingCompanions", () => {
  it("names every companion the repo provides that did not contribute", () => {
    const registry = createPluginRegistry();
    registry.append([
      owner,
      plugin("ui.icons.sprites", [
        IconsRoot({ component: Nothing, companion: true }),
      ]),
    ]);
    const problems = missingCompanions(registry);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("ui.tokens.icons");
    expect(problems[0]).toContain('"ui.icons.root"');
  });

  it("is empty once every companion contributed", () => {
    const registry = createPluginRegistry();
    registry.append([
      owner,
      plugin("ui.icons.sprites", [
        IconsRoot({ component: Nothing, companion: true }),
      ]),
      plugin("ui.tokens.icons", [
        IconsRoot({ component: Nothing, companion: true }),
      ]),
    ]);
    expect(missingCompanions(registry)).toEqual([]);
  });

  it("reports a companion slot the manifest does not list", () => {
    const Unlisted = defineSlot<{ id: string }>({ companions: true });
    const registry = createPluginRegistry();
    registry.append([plugin("not.in.manifest", [], { unlisted: Unlisted })]);
    expect(missingCompanions(registry)).toEqual([
      expect.stringContaining("companions.generated.ts does not list it"),
    ]);
  });
});
