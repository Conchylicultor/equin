import type { Activation } from "@plugins/primitives/plugins/link-gesture/core";
import type { DataViewRowsCollection } from "../../core";

/** A row → where it goes, or `undefined` (the owner sends it nowhere). */
export type CollectionActivation = (row: unknown) => Activation | undefined;

/** One owner's resolver, as `CollectRowActivation` collected it. */
export interface ActivationAnswer {
  readonly id: string;
  /** The arm the contribution answers for (its rows only), or `null` — every row. */
  readonly arm: string | null;
  readonly resolve: CollectionActivation;
}

/**
 * Fold the row activations `collection`'s owners declared into one resolver.
 * An arm's answers only its own rows (the union's discriminator names a row's
 * arm — a Meta-DataView dispatches each row to its source); two answering one
 * row throws (a row goes one place); an arm's on a collection that is no
 * union throws.
 */
export function foldActivations(
  collection: Pick<DataViewRowsCollection, "key" | "arms">,
  answers: readonly ActivationAnswer[],
): CollectionActivation {
  const discriminator = collection.arms?.discriminator;
  if (discriminator === undefined && answers.some((a) => a.arm !== null)) {
    throw new Error(
      `data-view: an arm's row activation is registered on "${collection.key}", which is not a union.`,
    );
  }
  return (row) => {
    const kind =
      discriminator === undefined
        ? undefined
        : (row as Record<string, unknown>)[discriminator];
    let found: { id: string; activation: Activation } | undefined;
    for (const a of answers) {
      if (a.arm !== null && a.arm !== kind) continue;
      const activation = a.resolve(row);
      if (activation === undefined) continue;
      if (found !== undefined) {
        throw new Error(
          `data-view: two row activations of "${collection.key}" answer one row ("${found.id}", "${a.id}") — a row goes one place.`,
        );
      }
      found = { id: a.id, activation };
    }
    return found?.activation;
  };
}
