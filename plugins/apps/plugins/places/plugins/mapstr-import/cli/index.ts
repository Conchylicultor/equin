import { defineCliCommand } from "@plugins/framework/plugins/cli/core";
import type {
  ImportMapstrOptions,
  SearchPlaceOptions,
} from "./internal/options";

/**
 * `./singularity places …` — the Places app's terminal verbs. The import boots
 * this checkout's backend in `exec` mode (it needs the DB, the Maps key and the
 * jobs queue), so the checkout must have been built once.
 */
export default defineCliCommand({
  name: "places",
  description: "Places app maintenance (imports, …)",
  subcommands: [
    defineCliCommand<[string], ImportMapstrOptions>({
      name: "import-mapstr",
      description:
        "Match a Mapstr export (mapstr.zip, or its extracted folder) to Google places and write mapstr-matches.json for review; with --apply, REPLACE every place and tag with the seed tree and the matched places",
      arguments: [
        {
          name: "<path>",
          description:
            "mapstr.zip, or the folder holding mapstr.csv + mapstr.geojson",
        },
      ],
      options: [
        {
          flags: "--out <file>",
          description:
            "The matches file (default: mapstr-matches.json next to the zip, or inside the folder)",
        },
        {
          flags: "--refresh",
          description:
            "Search every place again instead of reusing the matches file's stored searches",
        },
        {
          flags: "--rescore",
          description:
            "Re-decide every row from its stored searches, with no Google call (after a scorer change)",
        },
        {
          flags: "--overrides <file>",
          description:
            'Record hand decisions from a JSON file, one per row: { "index": 954, "googlePlaceId": "ChIJ…", "title"?: "My name", "note"?: "evidence" } (each id checked with one Place Details call and kept with its details), { "index": 12, "custom": { "name": "Bunker", "lat"?: 52.5, "lng"?: 13.4 } } (no Google place; the pin defaults to Mapstr\'s), or { "index": 7, "discard": true, "reason": "…" }',
        },
        {
          flags: "--apply",
          description:
            "Write the reviewed matches file into this checkout's DB: deletes ALL places and tags first (one transaction)",
        },
      ],
      run: () => import("./internal/run"),
    }),
    defineCliCommand<[string], SearchPlaceOptions>({
      name: "search-place",
      description:
        "Google's top 10 places for a query (id, name, address, types, distance, business status) — read-only, to decide a Mapstr row by hand",
      arguments: [
        { name: "<query>", description: 'e.g. "Palais Garnier, Paris"' },
      ],
      options: [
        {
          flags: "--near <lat,lng>",
          description:
            "Bias toward this point, and print each hit's distance from it",
        },
        {
          flags: "--lang <code>",
          description: 'Name hits in this language ("fr", "de")',
        },
        {
          flags: "--radius <m>",
          description:
            "The bias circle's radius in metres (default 2000, max 50000)",
        },
      ],
      run: () => import("./internal/search-place-run"),
    }),
  ],
});
