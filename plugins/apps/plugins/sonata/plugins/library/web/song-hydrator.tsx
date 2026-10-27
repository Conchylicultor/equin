import type { ReactNode } from "react";
import type { ResourceResult } from "@plugins/primitives/plugins/live-state/web";
import { mapRow, useLiveRow } from "@plugins/network/plugins/live/web";
import { songLibrary } from "../core";
import { Library, type SourceHydration } from "./slots";
import { combineHydrations, type SongHydration } from "./hydrate-sources";

type Source = ReturnType<typeof Library.Source.useContributions>[number];
type Hydrations = Readonly<Record<string, ResourceResult<SourceHydration>>>;

interface StepProps {
  sources: readonly Source[];
  index: number;
  songId: string;
  acc: Hydrations;
  /** The song's owning source (its library row's `source`), see `combineHydrations`. */
  owner: ResourceResult<string | null>;
  children: (hydration: ResourceResult<SongHydration>) => ReactNode;
}

/**
 * Hydrate one song from every `Library.Source` contribution, live, and hand
 * the folded answer to `children`: `loading` until every source answered
 * (and the song's owning source — its library row's `source` — holds its raw,
 * unless a source is pending),
 * `error` if one read failed, else the raws by source and the sources still
 * preparing the song.
 *
 * Each source reads through its own hook (`useHydration`), and a contributed
 * set cannot be looped over with hooks — so every contribution is one
 * {@link SourceHydrator} element, nested: each calls its source's hook and
 * passes the accumulated answers to the next; the innermost renders
 * `children`. Each level is keyed by its source id, so a set that changes (the
 * deferred tier adding sources) remounts the levels that moved and never calls
 * one source's hook in another's slot.
 *
 * Every read is live: a source change re-renders the answer. Whoever loads the
 * answer into the player decides what a change to an already-loaded song does
 * (the player pane keeps a loaded song as it is).
 */
export function SongHydrator({
  songId,
  children,
}: {
  songId: string;
  children: StepProps["children"];
}): ReactNode {
  const sources = Library.Source.useContributions();
  const owner = mapRow(useLiveRow(songLibrary, songId), (song) =>
    song === null ? null : song.source,
  );
  return (
    <HydrationStep
      sources={sources}
      index={0}
      songId={songId}
      acc={{}}
      owner={owner}
    >
      {children}
    </HydrationStep>
  );
}

function HydrationStep(props: StepProps): ReactNode {
  const source = props.sources[props.index];
  if (source === undefined) {
    return props.children(combineHydrations(props.acc, props.owner));
  }
  return <SourceHydrator key={source.sourceId} source={source} {...props} />;
}

function SourceHydrator({
  source,
  sources,
  index,
  songId,
  acc,
  owner,
  children,
}: StepProps & { source: Source }): ReactNode {
  const { useHydration } = source;
  const hydration = useHydration(songId);
  return (
    <HydrationStep
      sources={sources}
      index={index + 1}
      songId={songId}
      acc={{ ...acc, [source.sourceId]: hydration }}
      owner={owner}
    >
      {children}
    </HydrationStep>
  );
}
