import type { ComponentType } from "react";
import {
  combineResources,
  mapResource,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import type { SourceHydration } from "./slots";

/** A source that has content for a song that is not ready yet. */
export interface PendingSource {
  sourceId: string;
  label: string;
  Body: ComponentType<{ songId: string }>;
}

/** Every source's hydration for one song, folded: raws by source, and the pending ones. */
export interface HydratedSong {
  rawMap: Record<string, unknown>;
  pending: PendingSource[];
}

/**
 * One song's hydration, every source answered: `hydrated` (the fold), or
 * `awaiting-owner` — nothing pending, yet the song's owning source has no raw
 * yet (see `combineHydrations`): not a song with nothing to load, so a host
 * waits (renders its loading state) rather than loading an empty score.
 */
export type SongHydration =
  | ({ kind: "hydrated" } & HydratedSong)
  | { kind: "awaiting-owner"; owner: string };

/**
 * Fold every source's hydration of one song. Source-agnostic: an `absent`
 * source is skipped, a `raw` one lands in `rawMap`, a `pending` one is
 * collected so the caller can render its Body instead of loading the document.
 */
export function foldHydrations(
  bySource: Readonly<Record<string, SourceHydration>>,
): HydratedSong {
  const rawMap: Record<string, unknown> = {};
  const pending: PendingSource[] = [];
  for (const [sourceId, result] of Object.entries(bySource)) {
    switch (result.kind) {
      case "raw":
        rawMap[sourceId] = result.raw;
        break;
      case "absent":
        break;
      case "pending":
        pending.push({ sourceId, label: result.label, Body: result.Body });
        break;
    }
  }
  return { rawMap, pending };
}

/**
 * Every source's live hydration read, folded into one: `loading` until every
 * source answered, `error` as soon as one read failed (a song is never opened
 * from some of its sources), else the folded {@link SongHydration}.
 *
 * `owner` is the song's OWNING source (its library row's `source`; `null` when
 * the row is gone): the answer is `awaiting-owner` while every source answered,
 * none is pending, and the owner (a contributed source) has no raw yet. The sources are separate live
 * reads with no barrier between them, so a song whose content just landed (a
 * transcription marked ready, its MusicXML row a moment behind) can answer
 * "nothing pending" before its own source's content arrives — a load then
 * would open an empty score and never reload it.
 */
export function combineHydrations(
  bySource: Readonly<Record<string, ResourceResult<SourceHydration>>>,
  owner: ResourceResult<string | null>,
): ResourceResult<SongHydration> {
  return mapResource(
    combineResources({ sources: combineResources(bySource), owner }),
    ({ sources, owner: own }): SongHydration => {
      const folded = foldHydrations(sources);
      if (
        own !== null &&
        own in bySource &&
        folded.pending.length === 0 &&
        !(own in folded.rawMap)
      ) {
        return { kind: "awaiting-owner", owner: own };
      }
      return { kind: "hydrated", ...folded };
    },
  );
}
