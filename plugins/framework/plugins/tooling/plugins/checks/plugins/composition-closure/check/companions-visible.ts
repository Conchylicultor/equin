import { existsSync } from "fs";
import { join, relative } from "path";
import { buildRegistryGenContext } from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { getFacet } from "@plugins/plugin-meta/plugins/facets/core";
import { contributionsFacetDef } from "@plugins/plugin-meta/plugins/facets/plugins/contributions/core";
import { crossRefsFacetDef } from "@plugins/plugin-meta/plugins/facets/plugins/cross-refs/core";
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
 *
 * Server companions (a contribution kind opened with
 * `defineServerContribution(name, { companions: true })`) get the same count
 * comparison per `server/` barrel, and a `machine/` barrel must carry none.
 */
export const companionsVisible: Check = {
  id: "companions-visible",
  description:
    "Every `companion: true` contribution a web or server barrel carries at runtime is written inline in its `contributions: [ … ]` literal, where the closure engine's static parse reads it (and none sits in a `machine/` barrel)",
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

    // Server companions (`Kind({ …, companion: true })` to a kind declared
    // `defineServerContribution(name, { companions: true })`): the same
    // comparison over each `server/` barrel. A `machine/` barrel may carry
    // none — the static parse throws on one written inline, so a runtime one
    // there was built elsewhere.
    //
    // Only a half that IMPORTS a companion kind's token from its owner can
    // carry one, so only those are imported — read off the cross-refs facet's
    // per-runtime uses (the engine's own reading), never a walk of the files.
    const kinds = new Set<string>();
    for (const node of tree.byDir.values())
      for (const k of getFacet(node, contributionsFacetDef)
        ?.serverCompanionKinds ?? [])
        kinds.add(`${node.id}\0${k.binding}`);
    const namesKind = (
      node: Parameters<typeof getFacet>[0],
      folder: "server" | "machine",
    ): boolean =>
      (getFacet(node, crossRefsFacetDef)?.apiUses[folder] ?? []).some(
        (u) => u.symbol !== undefined && kinds.has(`${u.plugin}\0${u.symbol}`),
      );
    for (const node of tree.byDir.values()) {
      const facet = getFacet(node, contributionsFacetDef);
      for (const folder of ["server", "machine"] as const) {
        const barrel = join(node.dir, folder, "index.ts");
        if (!existsSync(barrel)) continue;
        if (!namesKind(node, folder)) continue;
        let mod: Record<string, unknown>;
        try {
          mod = await importBarrel(barrel);
        } catch (err) {
          return {
            ok: false,
            message: `Failed to import ${folder} barrel ${relative(root, barrel)}: ${String(err)}`,
          };
        }
        const def = mod.default as
          { contributions?: Array<Record<string, unknown>> } | undefined;
        const runtime = (def?.contributions ?? []).filter(
          (c) => typeof c._kind === "symbol" && c.companion === true,
        ).length;
        const seen =
          folder === "server" ? (facet?.serverCompanions.length ?? 0) : 0;
        if (runtime !== seen)
          hidden.push(
            folder === "server"
              ? `${relative(root, barrel)}: ${runtime} server companion contribution(s) at runtime, ${seen} in the inline literal`
              : `${relative(root, barrel)}: ${runtime} companion contribution(s) in a \`machine/\` barrel — a browser host boots the kind's owner but never this half`,
          );
      }
    }

    if (hidden.length === 0) return { ok: true };
    return {
      ok: false,
      message:
        "Companion contributions the closure engine cannot see — they would ship as opt-in options, missing from every bundle that does not select them:\n  " +
        hidden.join("\n  "),
      hint: "A keyed slot's `companions: { key, space }` option and each companion's key prop must both be string literals at their call sites. Write each companion as an inline `Slot.Member({ …, companion: true })` call (a server one: `Kind({ …, companion: true })`, the token imported by name from its owner's `server/` barrel) in the barrel's `contributions: [ … ]` literal — a server companion in `server/index.ts`, never `machine/`. A barrel whose `contributions` is a live array (rewritten by the declaration pass) cannot host one: give the companion its own sub-plugin, as `reorder/plugins/slot-middleware` does.",
    };
  },
};
