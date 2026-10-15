import { db } from "@plugins/database/server";
import type { Place } from "../../core";
import { _places, _placeTags } from "./tables";
import { seedTagTree } from "./seed";
import type { SeedTagKey } from "./seed-tags";
import { insertPlace, type NewPlace } from "./places-repo";
import { placeIconJob } from "./place-icon";

/**
 * One place of a bulk import: where it comes from — a Google snapshot (under
 * the user's title, when they gave one) or a custom place — plus what the user
 * had on it.
 */
export interface ImportedPlace {
  place: NewPlace;
  /** Seed tags it carries, by key — resolved to the freshly seeded tree's ids. */
  tags: readonly SeedTagKey[];
  note: string;
  createdAt: Date;
}

/**
 * Replaces EVERY place and tag with a fresh seed tree and `imported` — the Mapstr
 * import's write. All of it is one transaction, icon jobs included (enqueued on
 * the same connection), so a failure part-way leaves the old places and tags
 * untouched and queues nothing. The caller fetches every snapshot BEFORE calling
 * this: no network call happens while the tables are wiped.
 *
 * Every tag is the user's own choice, so `autoTags` is empty. Two entries with
 * one Google id are a caller bug (it dedupes) and throw, rolling back; custom
 * places never conflict.
 */
export async function replaceAllPlaces(
  imported: readonly ImportedPlace[],
): Promise<Place[]> {
  return db.transaction(async (tx) => {
    await tx.delete(_places);
    await tx.delete(_placeTags);
    const seed = seedTagTree();
    await tx.insert(_placeTags).values(seed.rows);

    const inserted: Place[] = [];
    for (const entry of imported) {
      const tags = entry.tags.map((key) => {
        const id = seed.idByKey.get(key);
        if (id === undefined) throw new Error(`Unknown seed tag key: ${key}`);
        return id;
      });
      const result = await insertPlace(
        entry.place,
        { tags, autoTags: [], note: entry.note, createdAt: entry.createdAt },
        tx,
      );
      if (result.kind === "conflict") {
        // Only a Google place can conflict (on its id).
        const name =
          entry.place.kind === "google"
            ? `${entry.place.snapshot.placeId} ("${entry.place.snapshot.name}")`
            : `"${entry.place.name}"`;
        throw new Error(`Google place ${name} imported twice`);
      }
      inserted.push(result.place);
      await placeIconJob.enqueue({ placeId: result.place.id }, { tx });
    }
    return inserted;
  });
}
