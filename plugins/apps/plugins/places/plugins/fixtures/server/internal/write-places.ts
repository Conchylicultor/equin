import {
  readEndpointResponse,
  sendEndpointRequest,
} from "@plugins/infra/plugins/endpoints/core";
import {
  createTagPath,
  updateTag,
  HexColorSchema,
} from "@plugins/tag-tree/plugins/engine/core";
import { parseSavedSymbolName } from "@plugins/ui/plugins/icons/plugins/saved-names/core";
import {
  placeIdKind,
  placeTagTree,
} from "@plugins/apps/plugins/places/plugins/places-core/core";
import {
  insertPlace,
  seedStarterPlaceTags,
  type NewPlace,
} from "@plugins/apps/plugins/places/plugins/places-core/server";
import type { PlaceFixture, PlacesFixture, PlaceTagPath } from "../../core";

/** The host the writes go to: its router, as a page's request reaches it. */
export interface FixtureHost {
  request(req: Request): Promise<Response>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Write `fixture` through the Places app's real write paths: the starter tag
 * tree a fresh install seeds, the fixture's tags through the tag tree's own
 * endpoints (`createTagPath`, then `updateTag` for a colour or icon — a
 * person's edits in the tag manager), and each place through `insertPlace`,
 * the one insert every path that adds a place shares, its icon given (no
 * model is asked). Tag paths resolve against the tree as written, so a place
 * names a starter tag (`["Want to go"]`) or a fixture tag alike.
 */
export async function writePlacesFixture(
  fixture: PlacesFixture,
  host: FixtureHost,
  now: number = Date.now(),
): Promise<void> {
  await seedStarterPlaceTags();
  const send = (path: string, init: RequestInit) =>
    host.request(
      new Request(new URL(path, "http://places-fixture.invalid"), init),
    );
  const tree = { tree: placeTagTree.id };
  const ids = new Map<string, string>();
  const tagId = async (path: PlaceTagPath): Promise<string> => {
    const key = path.join("/");
    const known = ids.get(key);
    if (known !== undefined) return known;
    const res = await sendEndpointRequest(send, createTagPath, tree, {
      body: { segments: [...path] },
    });
    const { id } = await readEndpointResponse(createTagPath, res);
    ids.set(key, id);
    return id;
  };
  for (const tag of fixture.tags) {
    const id = await tagId(tag.path);
    if (tag.color === undefined && tag.icon === undefined) continue;
    const res = await sendEndpointRequest(
      send,
      updateTag,
      { ...tree, id },
      {
        body: {
          ...(tag.color === undefined
            ? {}
            : { color: HexColorSchema.parse(tag.color) }),
          ...(tag.icon === undefined
            ? {}
            : { icon: parseSavedSymbolName(tag.icon) }),
        },
      },
    );
    await readEndpointResponse(updateTag, res);
  }
  for (const place of fixture.places) {
    const tags: string[] = [];
    for (const path of place.tags) tags.push(await tagId(path));
    const result = await insertPlace(newPlace(place), {
      id: placeIdKind.parse(place.id),
      tags,
      autoTags: [],
      ...(place.note === undefined ? {} : { note: place.note }),
      createdAt: new Date(now - place.savedDaysAgo * DAY_MS),
      icon: parseSavedSymbolName(place.icon),
    });
    if (result.kind === "conflict") {
      throw new Error(
        `[places fixture] place ${place.id}: its Google place is saved twice`,
      );
    }
  }
}

function newPlace({ place }: PlaceFixture): NewPlace {
  if (place.kind === "custom") {
    return {
      kind: "custom",
      name: place.name,
      address: place.address,
      lat: place.lat,
      lng: place.lng,
    };
  }
  return {
    kind: "google",
    snapshot: {
      placeId: place.googlePlaceId,
      name: place.name,
      address: place.address,
      primaryType: place.primaryType,
      types: [...place.types],
      lat: place.lat,
      lng: place.lng,
      businessStatus: "OPERATIONAL",
    },
  };
}
