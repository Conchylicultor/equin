import { afterEach, expect, spyOn, test } from "bun:test";
import { placeRichDetails } from "./rich-details";
import { PLACE_RICH_DETAILS_FIELD_MASK } from "./field-mask";
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

const jsonBody = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });

afterEach(() => {
  (globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.();
});

test("asks for the rich mask and maps photos, hours, price and the rest", async () => {
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    jsonBody({
      photos: [
        {
          name: "places/ChIJ1/photos/AbC",
          widthPx: 4032,
          heightPx: 3024,
          authorAttributions: [
            { displayName: "Ana", uri: "https://maps.google.com/ana" },
          ],
        },
      ],
      // Google drops zero fields: Sunday is day 0, midnight hour 0.
      regularOpeningHours: {
        periods: [
          { open: { hour: 9 }, close: { day: 0, hour: 18, minute: 30 } },
        ],
        weekdayDescriptions: ["Sunday: 9:00 AM – 6:30 PM"],
      },
      utcOffsetMinutes: 120,
      rating: 4.6,
      userRatingCount: 182000,
      priceLevel: "PRICE_LEVEL_MODERATE",
      internationalPhoneNumber: "+33 1 30 83 78 00",
      websiteUri: "https://www.chateauversailles.fr/",
      editorialSummary: { text: "Opulent royal palace." },
    }),
  );
  const details = await placeRichDetails(client, "ChIJ1");
  const [url, init] = fetchSpy.mock.calls[0]!;
  expect(String(url)).toBe("https://places.googleapis.com/v1/places/ChIJ1");
  expect((init?.headers as Record<string, string>)["X-Goog-FieldMask"]).toBe(
    PLACE_RICH_DETAILS_FIELD_MASK,
  );
  expect(details).toEqual({
    photos: [
      {
        name: "places/ChIJ1/photos/AbC",
        widthPx: 4032,
        heightPx: 3024,
        authors: [{ name: "Ana", uri: "https://maps.google.com/ana" }],
      },
    ],
    hours: {
      periods: [
        {
          open: { day: 0, hour: 9, minute: 0 },
          close: { day: 0, hour: 18, minute: 30 },
        },
      ],
      weekdayDescriptions: ["Sunday: 9:00 AM – 6:30 PM"],
    },
    utcOffsetMinutes: 120,
    rating: 4.6,
    ratingCount: 182000,
    priceLevel: 2,
    phone: "+33 1 30 83 78 00",
    website: "https://www.chateauversailles.fr/",
    summary: "Opulent royal palace.",
  });
});

test("a place Google knows little about is photos: [] and nothing else", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(jsonBody({ id: "ChIJ2" }));
  expect(await placeRichDetails(client, "ChIJ2")).toEqual({ photos: [] });
});
