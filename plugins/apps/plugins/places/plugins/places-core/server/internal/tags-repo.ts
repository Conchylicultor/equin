import { db } from "@plugins/database/server";
import type { PlaceTag } from "../../core";
import { _placeTags } from "./tables";

// Tag reads for place writes (auto-tagging, Want to go, a PATCH's tag list).
// Tag writes are the tag-tree engine's (`placeTagTree`, served in
// `server/index.ts`); the rows reach the UI through the live `places.tags.all`.

export async function listTags(): Promise<PlaceTag[]> {
  return db.select().from(_placeTags);
}
