import type { ReactNode } from "react";
import { FileExplorer, type PlacesSource, type PlacesState } from "../slots";

/** One `FileExplorer.Places` source and what it answers now. */
export interface ResolvedPlaces {
  source: PlacesSource;
  state: PlacesState;
}

/**
 * Every `FileExplorer.Places` source's answer, in contribution order — for
 * whatever reads the places as a whole (the Places sidebar). Each source's `usePlaces` hook
 * runs in a component of its own, chained, so the call order never changes.
 */
export function ResolvePlaces({
  children,
}: {
  children: (resolved: readonly ResolvedPlaces[]) => ReactNode;
}): ReactNode {
  const sources = FileExplorer.Places.useContributions();
  return (
    <Chain sources={sources} index={0} resolved={[]}>
      {children}
    </Chain>
  );
}

function Chain({
  sources,
  index,
  resolved,
  children,
}: {
  sources: readonly PlacesSource[];
  index: number;
  resolved: readonly ResolvedPlaces[];
  children: (resolved: readonly ResolvedPlaces[]) => ReactNode;
}): ReactNode {
  const source = sources[index];
  if (source === undefined) return children(resolved);
  return (
    <ResolveSource key={source.id} source={source}>
      {(state) => (
        <Chain
          sources={sources}
          index={index + 1}
          resolved={[...resolved, { source, state }]}
        >
          {children}
        </Chain>
      )}
    </ResolveSource>
  );
}

function ResolveSource({
  source,
  children,
}: {
  source: PlacesSource;
  children: (state: PlacesState) => ReactNode;
}): ReactNode {
  const { usePlaces } = source;
  return children(usePlaces());
}
