import { afterEach, expect, spyOn, test } from "bun:test";
import { ZodError } from "zod";
import { searchText } from "./search-text";

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
  const hits = await searchText("KEY", "Lithium Café, 6 Rue Saint-Blaise", {
    bias: { lat: 48.8597, lng: 2.4046, radiusM: 250 },
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
    "places.id,places.displayName,places.location,places.types,places.formattedAddress,places.viewport,places.businessStatus",
  );
  expect(JSON.parse(String(init?.body))).toEqual({
    textQuery: "Lithium Café, 6 Rue Saint-Blaise",
    pageSize: 5,
    languageCode: "fr",
    locationBias: {
      circle: { center: { latitude: 48.8597, longitude: 2.4046 }, radius: 250 },
    },
  });
});

test("no places is an empty list; a hit without a location throws", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(jsonBody({}));
  expect(await searchText("KEY", "nowhere")).toEqual([]);
  (globalThis.fetch as unknown as { mockRestore: () => void }).mockRestore();

  spyOn(globalThis, "fetch").mockResolvedValue(
    jsonBody({ places: [{ id: "x", displayName: { text: "X" } }] }),
  );
  // `expect(p).rejects` is typed void under bun:test: assert the rejection by hand.
  const outcome = await searchText("KEY", "x").then(
    () => "resolved",
    (err: unknown) => err,
  );
  expect(outcome).toBeInstanceOf(ZodError);
});
