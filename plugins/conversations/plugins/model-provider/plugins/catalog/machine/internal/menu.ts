import {
  MODEL_TIERS,
  compareModelsNewestFirst,
  modelIdFromCliName,
  modelMeta,
  type ConversationModel,
  type ModelTier,
} from "@plugins/conversations/plugins/model-provider/core";
import type { CliModel } from "./cli-models";

/** The menu entry `--model default` stands for: the CLI's own pick, not a family. */
const DEFAULT_ENTRY = "default";

/** Something in the menu this code cannot place. Reported; nothing in the catalog changes for it. */
export type MenuProblem =
  /** A `value` that is neither a family nor a CLI model name: the CLI added an alias (or a family) this code does not know. */
  | { problem: "unknown-alias"; value: string; resolvedModel: string }
  /** A `resolvedModel` outside the id grammar: the CLI changed its naming. */
  | { problem: "not-a-model-id"; value: string; resolvedModel: string }
  /** A family alias resolving to another family's version. */
  | { problem: "family-mismatch"; value: string; resolvedModel: string }
  /** A family the menu does not list at all: its current version is kept, never guessed. */
  | { problem: "family-missing"; value: ModelTier; resolvedModel: null };

/** The menu, in the catalog's terms. */
export interface CliMenu {
  /**
   * Each family the menu lists an alias for, with its current version: the
   * NEWEST version of that family the menu offers — the alias's resolution or
   * a newer one the CLI offers by name (Fable 5.2 while `fable` still resolves
   * to 5.1). Launches pass the concrete version, never the alias.
   */
  current: Partial<Record<ModelTier, ConversationModel>>;
  /** Every version the menu offers, deduplicated, in menu order. */
  offered: ConversationModel[];
  problems: MenuProblem[];
}

function isFamily(value: string): value is ModelTier {
  return (MODEL_TIERS as readonly string[]).includes(value);
}

/**
 * Place every menu entry: a family alias names the family and offers the
 * version it resolves to, a CLI model name is a version the CLI still offers,
 * `default` is ignored (it is the CLI's pick of a family, already listed), and
 * anything else is a {@link MenuProblem}. A listed family's current version is
 * the newest of its offered versions, so a new release is picked up as soon as
 * the CLI offers it, whether or not its alias has moved yet.
 */
export function readMenu(models: readonly CliModel[]): CliMenu {
  const current: Partial<Record<ModelTier, ConversationModel>> = {};
  const offered = new Set<ConversationModel>();
  const problems: MenuProblem[] = [];
  for (const { value, resolvedModel } of models) {
    if (value === DEFAULT_ENTRY) continue;
    const family = isFamily(value);
    if (!family && !modelIdFromCliName(value).ok) {
      problems.push({ problem: "unknown-alias", value, resolvedModel });
      continue;
    }
    const id = modelIdFromCliName(resolvedModel);
    if (!id.ok) {
      problems.push({ problem: "not-a-model-id", value, resolvedModel });
      continue;
    }
    if (family) {
      if (modelMeta(id.id).family !== value) {
        problems.push({ problem: "family-mismatch", value, resolvedModel });
        continue;
      }
      current[value] = id.id;
    }
    offered.add(id.id);
  }
  for (const version of [...offered].sort(compareModelsNewestFirst)) {
    const family = modelMeta(version).family;
    const now = current[family];
    if (now !== undefined && compareModelsNewestFirst(version, now) < 0)
      current[family] = version;
  }
  for (const family of MODEL_TIERS)
    if (current[family] === undefined)
      problems.push({
        problem: "family-missing",
        value: family,
        resolvedModel: null,
      });
  return { current, offered: [...offered], problems };
}
