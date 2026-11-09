// The cascade of one remote push: which step of its arrival each new row
// enters at.
//
// The rows another writer added in ONE push mount in the same render, so a
// render's arriving rows ARE the batch. They arrive as one gesture
// (`<Arrival>`, `primitives/css/motion`): every slot opens together, and each
// row's content enters at its step, in document order. A row whose parent
// arrives in the same batch enters WITH it (a block's children are its
// content, never a step of their own); a row with nothing to show (an empty
// line) has no entry at all, its room just opens.

import type { ArrivalStep } from "@plugins/primitives/plugins/css/plugins/motion/web";
import type { Block } from "../../core";

/**
 * The step of every row in `rows` (document order) that `arrived`; a row
 * absent from the map is at rest. `isEmpty` says a row has nothing to show.
 */
export function arrivalSteps(
  rows: readonly { block: Block }[],
  arrived: (block: Block) => boolean,
  isEmpty: (block: Block) => boolean,
): ReadonlyMap<string, ArrivalStep> {
  const order = new Map<string, number | null>();
  let next = 0;
  for (const { block } of rows) {
    if (!arrived(block)) continue;
    const parent =
      block.parentId === null ? undefined : order.get(block.parentId);
    if (parent !== undefined && parent !== null) order.set(block.id, parent);
    else if (isEmpty(block)) order.set(block.id, null);
    else order.set(block.id, next++);
  }
  // Every row of the push knows its length: the room opens for the whole
  // cascade.
  const steps = new Map<string, ArrivalStep>();
  for (const [id, step] of order) steps.set(id, { step, steps: next });
  return steps;
}
