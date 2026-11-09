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
import { setConfigField } from "@plugins/config_v2/core";
import {
  dataViewStorePath,
  readDataViewConfigDoc,
} from "@plugins/primitives/plugins/data-view/server";
import { applySidebarState } from "@plugins/apps/plugins/places/plugins/places-map/core";
import type {
  PlaceFixture,
  PlacePresetFixture,
  PlacesFixture,
  PlaceTagPath,
} from "../../core";

/** The host the writes go to: its router, as a page's request reaches it. */
export interface FixtureHost {
  request(req: Request): Promise<Response>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The Places map's presets surface — `places-map`'s
 * `defineDataView("places.presets")`; `dataViewStorePath` throws if the two
 * ever part.
 */
const PRESETS_DATA_VIEW = "places.presets";

/**
 * Write `fixture` through the Places app's real write paths: the starter tag
 * tree a fresh install seeds, the fixture's tags through the tag tree's own
 * endpoints (`createTagPath`, then `updateTag` for a colour or icon — a
 * person's edits in the tag manager), and each place through `insertPlace`,
 * the one insert every path that adds a place shares, its icon given (no
 * model is asked). Tag paths resolve against the tree as written, so a place
 * names a starter tag (`["Want to go"]`) or a fixture tag alike. Then the
 * map's presets, after "All places", saved as the tag sidebar's "Save as
 * preset" saves one: its filter built by the sidebar's own `applySidebarState`
 * and the presets doc's `views` written through config-v2's `set-field`.
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
  if (fixture.presets !== undefined && fixture.presets.length > 0) {
    // A preset names tags the fixture's tags or places already wrote: one
    // naming a tag nothing uses is a mistake, never a new tag.
    const known = (path: PlaceTagPath): string => {
      const id = ids.get(path.join("/"));
      if (id === undefined) {
        throw new Error(
          `[places fixture] a preset names the tag ${path.join(" › ")}, which no fixture tag or place uses`,
        );
      }
      return id;
    };
    await writePresets(fixture.presets, known, send);
  }
}

async function writePresets(
  presets: readonly PlacePresetFixture[],
  tagId: (path: PlaceTagPath) => string,
  send: (path: string, init: RequestInit) => Promise<Response>,
): Promise<void> {
  const storePath = dataViewStorePath(PRESETS_DATA_VIEW);
  const { views } = readDataViewConfigDoc(PRESETS_DATA_VIEW);
  if (!Array.isArray(views)) {
    throw new Error(
      `[places fixture] the presets doc (${storePath}) holds no views list`,
    );
  }
  const taken = new Set(
    views.map((v: unknown) =>
      typeof v === "object" && v !== null && "id" in v ? v.id : undefined,
    ),
  );
  const added = presets.map((preset) => {
    if (taken.has(preset.id)) {
      throw new Error(
        `[places fixture] preset ${preset.id}: the presets doc already holds a view with that id`,
      );
    }
    taken.add(preset.id);
    const filter = applySidebarState(null, {
      rows: preset.tagged.map((row) => row.map(tagId)),
      exclude: (preset.notTagged ?? []).map(tagId),
    });
    if (filter === null) {
      throw new Error(`[places fixture] preset ${preset.id} filters nothing`);
    }
    return {
      id: preset.id,
      name: preset.name,
      icon: parseSavedSymbolName(preset.icon),
      view: { type: "map", filter },
    };
  });
  const res = await sendEndpointRequest(
    send,
    setConfigField,
    {},
    { body: { storePath, key: "views", value: [...views, ...added] } },
  );
  await readEndpointResponse(setConfigField, res);
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
