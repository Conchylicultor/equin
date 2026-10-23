import { useMemo } from "react";
import { useRawContributions } from "@plugins/framework/plugins/web-sdk/core";
import type { Hint } from "../../core";
import { Hints } from "../slots";
import type { AnyTour } from "./tour-machine";

/** Every declared hint (`Hints.Hint`), in registration order. */
export function useHints(): readonly Hint[] {
  const raw = useRawContributions(Hints.Hint);
  return useMemo(
    () => raw.map((c) => (c as unknown as { hint: Hint }).hint),
    [raw],
  );
}

/** Every declared tour (`Hints.Tour`), in registration order. */
export function useTours(): readonly AnyTour[] {
  const raw = useRawContributions(Hints.Tour);
  return useMemo(
    () => raw.map((c) => (c as unknown as { tour: AnyTour }).tour),
    [raw],
  );
}
