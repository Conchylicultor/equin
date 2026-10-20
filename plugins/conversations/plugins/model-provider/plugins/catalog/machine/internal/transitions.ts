import {
  MODEL_TIERS,
  type ConversationModel,
  type ModelCatalog,
  type ModelTier,
  type ModelVersion,
} from "@plugins/conversations/plugins/model-provider/core";
import type { CliMenu } from "./menu";

/** A family's current version moved. */
export interface CurrentMove {
  family: ModelTier;
  from: ConversationModel;
  to: ConversationModel;
}

/** What one discovery run changed. */
export interface MenuChanges {
  moves: CurrentMove[];
  added: ConversationModel[];
  retired: ConversationModel[];
  unretired: ConversationModel[];
}

/**
 * Fold the CLI's model menu into the catalog — the menu is the truth:
 *
 * - each family the menu lists runs what its alias resolves to; a family it
 *   leaves out keeps its current version (never guessed);
 * - a version never seen before is appended (first seen now, source `cli`);
 * - a known version the menu no longer offers is retired, and one it offers
 *   again is un-retired. A family's current version always counts as offered,
 *   so a family left out of the menu never retires what it runs.
 *
 * Pure: (catalog, menu) → next catalog plus what changed.
 */
export function applyMenu(
  catalog: ModelCatalog,
  menu: CliMenu,
  run: { now: Date; cliVersion: string },
): { catalog: ModelCatalog; changes: MenuChanges } {
  const at = run.now.toISOString();
  const current = { ...catalog.current };
  const moves: CurrentMove[] = [];
  for (const family of MODEL_TIERS) {
    const to = menu.current[family];
    if (to === undefined || to === current[family]) continue;
    moves.push({ family, from: current[family], to });
    current[family] = to;
  }

  const offered = new Set([...menu.offered, ...Object.values(current)]);
  const retired: ConversationModel[] = [];
  const unretired: ConversationModel[] = [];
  const versions = catalog.versions.map((v): ModelVersion => {
    const isRetired = v.retiredAt !== undefined;
    if (offered.has(v.id) && isRetired) {
      unretired.push(v.id);
      const { retiredAt: _at, retiredReason: _reason, ...live } = v;
      return live;
    }
    if (!offered.has(v.id) && !isRetired) {
      retired.push(v.id);
      return {
        ...v,
        retiredAt: at,
        retiredReason: `no longer offered by Claude Code ${run.cliVersion}`,
      };
    }
    return v;
  });

  const known = new Set(catalog.versions.map((v) => v.id));
  const added = [...offered].filter((id) => !known.has(id));
  for (const id of added) versions.push({ id, firstSeenAt: at, source: "cli" });

  return {
    catalog: { versions, current, probedAt: at, cliVersion: run.cliVersion },
    changes: { moves, added, retired, unretired },
  };
}
