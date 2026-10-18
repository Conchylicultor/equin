import { getFacet } from "@plugins/plugin-meta/plugins/facets/core";
import type { PluginTree } from "@plugins/plugin-meta/plugins/plugin-tree/core";
import type { PluginId } from "@plugins/framework/plugins/plugin-id/core";
import { slotsFacetDef } from "@plugins/plugin-meta/plugins/facets/plugins/slots/core";
import { contributionsFacetDef } from "@plugins/plugin-meta/plugins/facets/plugins/contributions/core";
import type { KeySpace } from "@plugins/framework/plugins/slot-declaration/core";

/** One companion contribution: the plugin, and the key it serves on a keyed slot. */
export interface CompanionEntry {
  plugin: PluginId;
  /** Set exactly when the slot is keyed. */
  key?: string;
}

/**
 * A slot opened to companions (`companions: true` or `{ key, space }`), with
 * every companion contributed to it across the tree. The one reading of the
 * companion facts: the closure engine turns it into edges and usage rules, and
 * the web registry's companion manifest is rendered from it — so what the build
 * ships and what the running app expects cannot disagree.
 */
export interface CompanionSlot {
  owner: PluginId;
  /** `Group.Member`, the spelling contributions name it by. */
  ref: string;
  /** The runtime slot id (`<owner>.<key>`). */
  slotId: string;
  /** Set when a companion is needed only while its key is used. */
  keyed?: { key: string; space: KeySpace };
  /** Sorted by plugin, then key. */
  companions: CompanionEntry[];
}

/**
 * Slot group → the plugin declaring it, first writer wins, `_runtimeOnly`
 * slots skipped. A contribution names its slot by group, so this is how a
 * contribution finds its owner.
 */
export function slotGroupOwners(tree: PluginTree): Map<string, PluginId> {
  const owners = new Map<string, PluginId>();
  for (const node of tree.byDir.values())
    for (const slot of getFacet(node, slotsFacetDef) ?? []) {
      if ((slot as { _runtimeOnly?: boolean })._runtimeOnly) continue;
      if (!owners.has(slot.groupName)) owners.set(slot.groupName, node.id);
    }
  return owners;
}

/** Every companion slot of the tree, sorted by slot id. */
export function collectCompanionSlots(
  tree: PluginTree,
  groupOwner: ReadonlyMap<string, PluginId> = slotGroupOwners(tree),
): CompanionSlot[] {
  const byRef = new Map<string, CompanionSlot>();
  for (const node of tree.byDir.values())
    for (const slot of getFacet(node, slotsFacetDef) ?? []) {
      if (!slot.companions) continue;
      if (groupOwner.get(slot.groupName) !== node.id) continue;
      const ref = `${slot.groupName}.${slot.memberName}`;
      if (byRef.has(ref)) continue;
      byRef.set(ref, {
        owner: node.id,
        ref,
        slotId: slot.slotId,
        ...(typeof slot.companions === "object"
          ? { keyed: slot.companions }
          : {}),
        companions: [],
      });
    }

  for (const node of tree.byDir.values()) {
    const data = getFacet(node, contributionsFacetDef);
    if (!data) continue;
    for (const contribution of data.static) {
      if (!contribution.companion) continue;
      const head = contribution.slot.split(".")[0];
      const owner = head ? groupOwner.get(head) : undefined;
      if (!owner || owner === node.id) continue;
      const slot = byRef.get(contribution.slot);
      if (!slot)
        throw new Error(
          `${node.id}: \`${contribution.slot}({ …, companion: true })\` — no slot opened to companions ` +
            `is spelled \`${contribution.slot}\`. The owner declares it with \`companions\` ` +
            "(or `defineRootSlot()`), and the static parse must be able to read that declaration.",
        );
      if (!slot.keyed) {
        slot.companions.push({ plugin: node.id });
        continue;
      }
      // The key is what decides whether this ships, so it must be readable:
      // a computed one would make the contribution a companion of nothing.
      const raw = contribution.props[slot.keyed.key]?.trim() ?? "";
      const literal = /^"([^"\\]+)"$/.exec(raw);
      if (!literal)
        throw new Error(
          `${node.id}: \`${contribution.slot}({ ${slot.keyed.key}: ${raw || "…"}, companion: true })\` — ` +
            `a companion of a keyed slot must spell its \`${slot.keyed.key}\` as a string literal ` +
            `at the call: the closure engine ships it only when that ${slot.keyed.space} is used.`,
        );
      slot.companions.push({ plugin: node.id, key: literal[1]! });
    }
  }

  const slots = [...byRef.values()].sort((a, b) =>
    a.slotId.localeCompare(b.slotId),
  );
  for (const slot of slots)
    slot.companions.sort(
      (a, b) =>
        a.plugin.localeCompare(b.plugin) ||
        (a.key ?? "").localeCompare(b.key ?? ""),
    );
  return slots;
}
