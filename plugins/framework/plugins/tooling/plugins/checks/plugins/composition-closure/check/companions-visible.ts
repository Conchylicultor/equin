import { existsSync } from "fs";
import { join, relative } from "path";
import { buildRegistryGenContext } from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { getFacet } from "@plugins/plugin-meta/plugins/facets/core";
import { contributionsFacetDef } from "@plugins/plugin-meta/plugins/facets/plugins/contributions/core";
import {
  registerBarrelStubs,
  importBarrel,
} from "@plugins/plugin-meta/plugins/barrel-import/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import type { SlotHandle } from "@plugins/framework/plugins/slot-declaration/core";

type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = { id: string; description: string; run(): Promise<CheckResult> };

/**
 * Every companion contribution the browser loads is one the closure engine can
 * see.
 *
 * The engine bundles a companion (`companion: true` on a contribution to a slot
 * opened with `companions: true`) from the STATIC parse of the plugin's inline
 * `contributions: [ … ]` literal — the composition pipeline runs barrel-free. A
 * companion built anywhere else (a helper, a pre-built const, a live array) is
 * real at runtime and invisible to the engine, so it ships as an opt-in option:
 * silently missing from every bundle that does not select it, which is exactly
 * the incident companions exist to prevent. This compares, per plugin, the
 * companions its imported barrel carries with the ones the static parse read.
 *
 * For a KEYED slot (`companions: { key, space }`) it also compares each
 * companion's key: the engine ships it through a usage rule read off the
 * static parse, so a runtime key the rules do not carry — the slot's option
 * unread, or a key spelled differently from the one it serves — is a
 * companion that ships when the wrong thing is used, or never.
 */
export const companionsVisible: Check = {
  id: "companions-visible",
  description:
    "Every `companion: true` contribution a web barrel carries at runtime is written inline in its `contributions: [ … ]` literal, where the closure engine's static parse reads it",
  async run() {
    const root = await getWorktreeRoot();
    const { tree, graph } = await buildRegistryGenContext(root);
    const ruleKeys = new Map<string, string[]>();
    for (const rule of graph.rules) {
      const list = ruleKeys.get(rule.then) ?? [];
      list.push(`${rule.space}:${rule.key}`);
      ruleKeys.set(rule.then, list);
    }
    registerBarrelStubs(root);

    const hidden: string[] = [];
    for (const node of tree.byDir.values()) {
      const webIndex = join(node.dir, "web", "index.ts");
      if (!existsSync(webIndex)) continue;
      let mod: Record<string, unknown>;
      try {
        mod = await importBarrel(webIndex);
      } catch (err) {
        return {
          ok: false,
          message: `Failed to import web barrel ${relative(root, webIndex)}: ${String(err)}`,
        };
      }
      const def = mod.default as
        { contributions?: Array<Record<string, unknown>> } | undefined;
      const companions = (def?.contributions ?? []).filter(
        (c) => c.companion === true,
      );
      const runtime = companions.length;
      if (runtime === 0) continue;
      const runtimeKeys: string[] = [];
      for (const c of companions) {
        const keyed = (c._slot as SlotHandle | undefined)?.meta.companions;
        if (typeof keyed !== "object") continue;
        runtimeKeys.push(`${keyed.space}:${String(c[keyed.key])}`);
      }
      const staticKeys = ruleKeys.get(node.id) ?? [];
      const sameKeys =
        runtimeKeys.length === staticKeys.length &&
        [...runtimeKeys].sort().join() === [...staticKeys].sort().join();
      if (!sameKeys) {
        hidden.push(
          `${relative(root, webIndex)}: keyed companion(s) [${runtimeKeys.join(", ")}] at runtime, [${staticKeys.join(", ")}] in the closure's usage rules`,
        );
        continue;
      }
      const seen = (getFacet(node, contributionsFacetDef)?.static ?? []).filter(
        (c) => c.companion,
      ).length;
      if (seen !== runtime) {
        hidden.push(
          `${relative(root, webIndex)}: ${runtime} companion contribution(s) at runtime, ${seen} in the inline literal`,
        );
      }
    }

    if (hidden.length === 0) return { ok: true };
    return {
      ok: false,
      message:
        "Companion contributions the closure engine cannot see — they would ship as opt-in options, missing from every bundle that does not select them:\n  " +
        hidden.join("\n  "),
      hint: "A keyed slot's `companions: { key, space }` option and each companion's key prop must both be string literals at their call sites. Write each companion as an inline `Slot.Member({ …, companion: true })` call in the barrel's `contributions: [ … ]` literal. A barrel whose `contributions` is a live array (rewritten by the declaration pass) cannot host one: give the companion its own sub-plugin, as `reorder/plugins/slot-middleware` does.",
    };
  },
};
