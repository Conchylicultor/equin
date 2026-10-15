import type { ImportedPlace } from "@plugins/apps/plugins/places/plugins/places-core/server";
import type { PlaceSnapshot } from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";
import type { MapstrPlace } from "./export";
import { nameSimilarity } from "./match";
import { mapMapstrTags } from "./tag-map";

/** Below this, the Google name no longer says which place the user saved. */
const SAME_NAME_SIMILARITY = 0.5;

/** One Mapstr row, resolved to what `--apply` writes for it. */
export interface ResolvedRow {
  place: MapstrPlace;
  source:
    | {
        kind: "google";
        snapshot: PlaceSnapshot;
        /** The user's own name for it, shown instead of Google's. */
        title?: string;
      }
    /** No Google place: a custom place, under its own name, at its pin. */
    | { kind: "custom"; name: string; lat: number; lng: number };
}

/**
 * The places `--apply` writes: one per Google place, never fewer Mapstr rows.
 * Rows resolving to one Google place (one place saved twice, a museum now
 * inside another) merge into the first — tags united, notes kept, earliest
 * save date, the first title given. A row whose Google name no longer says
 * what the user saved (a renamed venue, the address standing in for a closed
 * one) and that has no title keeps its Mapstr name as the note's first line,
 * since the place's name comes from Google. A custom place is its own name
 * and never merges.
 */
export function mergeImports(rows: readonly ResolvedRow[]): ImportedPlace[] {
  const out: ImportedPlace[] = [];
  /** Index into `out` of each Google place's first row. */
  const byGoogleId = new Map<string, number>();
  for (const { place, source } of [...rows].sort(
    (a, b) => a.place.index - b.place.index,
  )) {
    const tags = mapMapstrTags(place.tags);
    const createdAt = new Date(place.date);
    if (source.kind === "custom") {
      out.push({
        place: {
          kind: "custom",
          name: source.name,
          address: place.address,
          lat: source.lat,
          lng: source.lng,
        },
        tags,
        note: place.note,
        createdAt,
      });
      continue;
    }
    const { snapshot } = source;
    const title = source.title ?? null;
    const at = byGoogleId.get(snapshot.placeId);
    if (at === undefined) {
      const renamed =
        title === null &&
        nameSimilarity(place.name, snapshot.name) < SAME_NAME_SIMILARITY;
      byGoogleId.set(snapshot.placeId, out.length);
      out.push({
        place: { kind: "google", snapshot, title },
        tags,
        note: joinNote(
          renamed ? `Saved in Mapstr as “${place.name}”.` : "",
          place.note,
        ),
        createdAt,
      });
      continue;
    }
    const first = out[at];
    if (first?.place.kind !== "google") {
      throw new Error(`entry ${at} is indexed by a Google id but is not one`);
    }
    const mergedTitle = first.place.title ?? title;
    out[at] = {
      place: {
        kind: "google",
        snapshot: first.place.snapshot,
        title: mergedTitle,
      },
      tags: [...new Set([...first.tags, ...tags])],
      note: joinNote(
        first.note,
        joinNote(
          place.name === mergedTitle
            ? ""
            : `Also saved in Mapstr as “${place.name}”.`,
          place.note,
        ),
      ),
      createdAt: createdAt < first.createdAt ? createdAt : first.createdAt,
    };
  }
  return out;
}

function joinNote(a: string, b: string): string {
  return [a, b].filter((s) => s.trim() !== "").join("\n\n");
}
