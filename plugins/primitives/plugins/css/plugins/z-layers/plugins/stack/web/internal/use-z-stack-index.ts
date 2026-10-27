import { useMemo } from "react";
import { useSlotOrder } from "@plugins/primitives/plugins/slot-render/web";
import {
  mapResource,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import { ZStack, type ZStackLayer } from "./slots";

/**
 * The stack sits strictly between the generic portaled layers: above
 * `--z-popover` (50) and below `--z-max` (9999), both in ui-kit's app.css.
 */
const STACK_FLOOR = 50;
const STACK_CEILING = 9999;

/**
 * A declared layer's z-index: its position in the committed stack order, above
 * every popover. Only the ORDER is meaningful — a deferred tier loading more
 * layers shifts the numbers, never the order.
 *
 * A read: `loading` while the stack order is not known yet — the surface
 * renders nothing until it is, never a guessed z-index it would then change
 * (on error, `stale` is the index in the last-known order).
 *
 * Throws (once the order is known) when the layer is not on the stack (its
 * plugin's barrel forgot it, or the order file hides it) or when two plugins
 * contribute the same id (the handle names a layer by id).
 */
export function useZStackIndex(layer: ZStackLayer): ResourceResult<number> {
  const ordered = useSlotOrder(ZStack.Layer);
  return useMemo(
    () =>
      mapResource(ordered, (list) => {
        const at = list.flatMap((c, i) => (c.id === layer.id ? [i] : []));
        if (at.length === 0) {
          throw new Error(
            `[z-layers/stack] layer "${layer.id}" is not on the stack — list it in its plugin's web barrel \`contributions\`, and never hide it in the stack order file (a layer has no "hidden")`,
          );
        }
        if (at.length > 1) {
          throw new Error(
            `[z-layers/stack] ${at.length} plugins contribute a layer "${layer.id}" — a layer id is unique across the stack`,
          );
        }
        const z = STACK_FLOOR + 1 + at[0]!;
        if (z >= STACK_CEILING) {
          throw new Error(
            `[z-layers/stack] stack overflows into --z-max (${z})`,
          );
        }
        return z;
      }),
    [ordered, layer.id],
  );
}
