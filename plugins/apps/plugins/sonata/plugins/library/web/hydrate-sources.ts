import type { ComponentType } from "react";
import type { SourceContext, SourceHydration } from "./slots";

/** A source that has content for a song that is not ready yet. */
export interface PendingSource {
  sourceId: string;
  label: string;
  Body: ComponentType<{ songId: string }>;
}

/** Every source's hydration for one song, folded: raws by source, and the pending ones. */
export interface SongHydration {
  rawMap: Record<string, unknown>;
  pending: PendingSource[];
}

/**
 * Hydrate every source for `songId` and fold the results. Source-agnostic: an
 * `absent` source is skipped, a `raw` one lands in `rawMap`, a `pending` one is
 * collected so the caller can render its Body instead of loading the document.
 */
export async function hydrateSources(
  sources: readonly {
    sourceId: string;
    hydrate: (songId: string, ctx: SourceContext) => Promise<SourceHydration>;
  }[],
  songId: string,
  ctx: SourceContext,
): Promise<SongHydration> {
  const results = await Promise.all(
    sources.map(async (s) => ({
      sourceId: s.sourceId,
      result: await s.hydrate(songId, ctx),
    })),
  );
  const rawMap: Record<string, unknown> = {};
  const pending: PendingSource[] = [];
  for (const { sourceId, result } of results) {
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
