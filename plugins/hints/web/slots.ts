import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import type { Hint } from "../core";
import type { AnyTour } from "./internal/tour-machine";

export const Hints = {
  /**
   * Declares a contextual tip, so the catalog (and "Show tips again") knows
   * it. Showing it is still the owner's `useHintMoment(hint, when)`.
   *
   * Companions: a contribution flagged `companion: true` ships wherever the
   * engine does.
   */
  Hint: defineSlot<{ hint: Hint }>({
    docLabel: (p) => p.hint.id,
    companions: true,
  }),
  /**
   * Declares a tour: `startTour(id)` and `autoStart` resolve it here. Tours of
   * any data shape share the slot, so the payload is held erased (see
   * `AnyTour`).
   */
  Tour: defineSlot<{ tour: AnyTour }>({
    docLabel: (p) => p.tour.id,
    companions: true,
  }),
};
