import { useMemo } from "react";
import { useTransport } from "@plugins/primitives/plugins/networking/web";
import type { MachineAvailability, MachineFeature } from "../../core";
import { unavailableMessage } from "../../core";

/**
 * Whether a desktop-only declaration (an endpoint or a live read declared
 * `needsMachine`) can be asked in this subtree — for gating UI before a click:
 * a launch control renders disabled with the `message`, rather than offering
 * an action that can only answer "not available". Decided by the subtree's
 * transport (`machine`), which is fixed, so the answer is too.
 */
export function useMachineAvailability(declaration: {
  readonly needsMachine: MachineFeature;
}): MachineAvailability {
  const { machine } = useTransport();
  const { needsMachine } = declaration;
  return useMemo(
    () =>
      machine
        ? { available: true }
        : { available: false, message: unavailableMessage(needsMachine) },
    [machine, needsMachine],
  );
}
