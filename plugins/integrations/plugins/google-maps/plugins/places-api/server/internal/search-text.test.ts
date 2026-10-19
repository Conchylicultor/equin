import { afterEach, expect, spyOn, test } from "bun:test";
import { ZodError } from "zod";
import { searchText } from "./search-text";
import type { PlacesClient, PlacesSku } from "../../core";

const recorded: PlacesSku[] = [];
const client: PlacesClient = {
  apiKey: "KEY",
  meter: {
    record: (sku) => {
      recorded.push(sku);
      return Promise.resolve();
    },
  },
};

// A fetch mock's JSON body (not a handler response — handlers return objects from implement()).
const jsonBody = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });

afterEach(() => {
  // Each test installs its own fetch spy.
  (globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.();
});

test("posts the query, field mask and location bias; maps the hits", async () => {
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    jsonBody({
      places: [
        {
          id: "ChIJ1",
          displayName: { text: "Lithium Café" },
          location: { latitude: 48.86, longitude: 2.4 },
          types: ["cafe", "establishment"],
          formattedAddress: "6 Rue Saint-Blaise, 75020 Paris",
          businessStatus: "OPERATIONAL",
          viewport: {
            low: { latitude: 48.85, longitude: 2.39 },
            high: { latitude: 48.87, longitude: 2.41 },
          },
        },
      ],
    }),
  );
  const hits = await searchText(client, "Lithium Café, 6 Rue Saint-Blaise", {
    bias: { kind: "circle", lat: 48.8597, lng: 2.4046, radiusM: 250 },
    languageCode: "fr",
  });
  expect(hits).toEqual([
    {
      placeId: "ChIJ1",
      name: "Lithium Café",
      lat: 48.86,
      lng: 2.4,
      types: ["cafe", "establishment"],
      address: "6 Rue Saint-Blaise, 75020 Paris",
      businessStatus: "OPERATIONAL",
      viewport: {
        low: { lat: 48.85, lng: 2.39 },
        high: { lat: 48.87, lng: 2.41 },
      },
    },
  ]);

  const [url, init] = fetchSpy.mock.calls[0] ?? [];
  expect(String(url)).toBe(
    "https://places.googleapis.com/v1/places:searchText",
  );
  const headers = init?.headers as Record<string, string>;
  expect(headers["X-Goog-FieldMask"]).toBe(
    "places.id,places.displayName,places.location,places.types,places.formattedAddress,places.viewport,places.businessStatus,places.primaryType,places.primaryTypeDisplayName",
  );
  expect(JSON.parse(String(init?.body))).toEqual({
    textQuery: "Lithium Café, 6 Rue Saint-Blaise",
    pageSize: 5,
    languageCode: "fr",
    locationBias: {
      circle: { center: { latitude: 48.8597, longitude: 2.4046 }, radius: 250 },
    },
  });
  expect(recorded.at(-1)).toBe("text-search-pro");
});

test("rich detail: a box bias, and the card facts mapped", async () => {
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    jsonBody({
      places: [
        {
          id: "ChIJ2",
          displayName: { text: "Trois Fois Plus de Piment" },
          location: { latitude: 48.86, longitude: 2.35 },
          types: ["sichuan_restaurant", "restaurant"],
          formattedAddress: "184 Rue Saint-Martin, 75003 Paris",
          primaryType: "sichuan_restaurant",
          primaryTypeDisplayName: { text: "Sichuan restaurant" },
          rating: 4.5,
          userRatingCount: 3100,
          priceLevel: "PRICE_LEVEL_INEXPENSIVE",
          currentOpeningHours: {
            periods: [
              { open: { day: 1, hour: 12 }, close: { day: 1, hour: 23 } },
            ],
            weekdayDescriptions: ["Monday: 12:00 – 11:00 PM"],
          },
          utcOffsetMinutes: 120,
        },
      ],
    }),
  );
  const [hit] = await searchText(client, "sichuan", {
    detail: "rich",
    maxResults: 20,
    bias: {
      kind: "rectangle",
      low: { lat: 48.8, lng: 2.3 },
      high: { lat: 48.9, lng: 2.4 },
    },
  });
  expect(hit).toMatchObject({
    category: "Sichuan restaurant",
    primaryType: "sichuan_restaurant",
    rating: 4.5,
    ratingCount: 3100,
    priceLevel: 1,
    utcOffsetMinutes: 120,
    hours: {
      periods: [
        {
          open: { day: 1, hour: 12, minute: 0 },
          close: { day: 1, hour: 23, minute: 0 },
        },
      ],
    },
  });
  const [, init] = fetchSpy.mock.calls[0] ?? [];
  expect(JSON.parse(String(init?.body))).toMatchObject({
    pageSize: 20,
    locationBias: {
      rectangle: {
        low: { latitude: 48.8, longitude: 2.3 },
        high: { latitude: 48.9, longitude: 2.4 },
      },
    },
  });
  expect(recorded.at(-1)).toBe("text-search-enterprise");
});

test("no places is an empty list; a hit without a location throws", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(jsonBody({}));
  expect(await searchText(client, "nowhere")).toEqual([]);
  (globalThis.fetch as unknown as { mockRestore: () => void }).mockRestore();

  spyOn(globalThis, "fetch").mockResolvedValue(
    jsonBody({ places: [{ id: "x", displayName: { text: "X" } }] }),
  );
  // `expect(p).rejects` is typed void under bun:test: assert the rejection by hand.
  const outcome = await searchText(client, "x").then(
    () => "resolved",
    (err: unknown) => err,
  );
  expect(outcome).toBeInstanceOf(ZodError);
});
