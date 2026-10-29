import {
  mapRow,
  useLive,
  useLiveMutation,
  useLiveRow,
} from "@plugins/network/plugins/live/web";
import type { ResourceResult } from "@plugins/primitives/plugins/live-state/web";
import {
  NO_PROTOTYPE_STATE,
  prototypeStates,
  setPrototypeState,
  type PrototypeState,
  type PrototypeStateChange,
} from "../../core";

/** Every recorded prototype state, live (a prototype with no row has `NO_PROTOTYPE_STATE`). */
export function usePrototypeStates() {
  return useLive(prototypeStates);
}

/**
 * One prototype's state, live: pending while unknown, `NO_PROTOTYPE_STATE`
 * once known to have no row.
 */
export function usePrototypeState(
  name: string,
): ResourceResult<PrototypeState> {
  return mapRow(
    useLiveRow(prototypeStates, name),
    (row): PrototypeState => row ?? NO_PROTOTYPE_STATE,
  );
}

/**
 * Apply one change (`{ done }`, `{ pinned }`, `{ tagId }`) to a prototype's
 * state. Predicted: every surface shows it at once, so there is no pending
 * state; a refused write is the rejection toast.
 */
export function useSetPrototypeState(): {
  setState: (name: string, change: PrototypeStateChange) => void;
} {
  const mutation = useLiveMutation(setPrototypeState);
  return {
    setState: (name, change) =>
      mutation.mutate({ params: { name }, body: change }),
  };
}
