import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import { parseCsv } from "./csv";
import { readZipEntries } from "./zip";

/** One saved place of a Mapstr export: the CSV row joined with its GeoJSON point. */
export interface MapstrPlace {
  /** Row position in the export — the join key between the two files. */
  index: number;
  name: string;
  address: string;
  lat: number;
  lng: number;
  /** When it was saved in Mapstr (ISO instant). */
  date: string;
  /** The user's comment; "" when none. */
  note: string;
  /** Its Mapstr tags, deduped, in export order. */
  tags: string[];
}

export interface MapstrExport {
  places: MapstrPlace[];
  /** sha256 of mapstr.csv — ties a matches file to the export it was made from. */
  csvSha256: string;
}

const CSV_NAME = "mapstr.csv";
const GEOJSON_NAME = "mapstr.geojson";
const CSV_HEADER = [
  "date",
  "name",
  "address",
  "icon",
  "userComment",
  "rating",
  "tags",
  "photos",
] as const;

const GeoJsonSchema = z.object({
  type: z.literal("FeatureCollection"),
  features: z.array(
    z.object({
      geometry: z.object({
        type: z.literal("Point"),
        coordinates: z.tuple([z.number(), z.number()]).rest(z.number()),
      }),
      properties: z.object({ name: z.string() }),
    }),
  ),
});

/** Reads a Mapstr export: `mapstr.zip`, or the folder it extracts to. */
export async function readMapstrExport(path: string): Promise<MapstrExport> {
  const { csv, geojson } = (await stat(path)).isDirectory()
    ? {
        csv: await readFile(join(path, CSV_NAME)),
        geojson: await readFile(join(path, GEOJSON_NAME)),
      }
    : filesFromZip(await readFile(path), path);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return {
    places: parseMapstrExport(decoder.decode(csv), decoder.decode(geojson)),
    csvSha256: createHash("sha256").update(csv).digest("hex"),
  };
}

function filesFromZip(
  zip: Uint8Array,
  path: string,
): { csv: Uint8Array; geojson: Uint8Array } {
  const entries = readZipEntries(zip);
  const find = (name: string): Uint8Array => {
    const hits = [...entries].filter(([entry]) => basename(entry) === name);
    const [hit] = hits;
    if (hits.length !== 1 || hit === undefined) {
      throw new Error(
        `${path}: expected exactly one ${name}, found ${hits.length} (entries: ${[...entries.keys()].join(", ")})`,
      );
    }
    return hit[1];
  };
  return { csv: find(CSV_NAME), geojson: find(GEOJSON_NAME) };
}

/**
 * Joins the two files of an export by row order. The CSV carries the date (the
 * GeoJSON has none), the GeoJSON the coordinates (the CSV has none); a row whose
 * names disagree means the files are not one export, and throws.
 */
export function parseMapstrExport(
  csvText: string,
  geojsonText: string,
): MapstrPlace[] {
  const [header, ...rows] = parseCsv(csvText);
  if (header?.join(",") !== CSV_HEADER.join(",")) {
    throw new Error(
      `Unexpected ${CSV_NAME} header: ${header?.join(",")} (want ${CSV_HEADER.join(",")})`,
    );
  }
  const features = GeoJsonSchema.parse(JSON.parse(geojsonText)).features;
  if (features.length !== rows.length) {
    throw new Error(
      `${CSV_NAME} has ${rows.length} places but ${GEOJSON_NAME} has ${features.length}`,
    );
  }

  return rows.map((row, index) => {
    if (row.length !== CSV_HEADER.length) {
      throw new Error(
        `${CSV_NAME} row ${index + 1} has ${row.length} fields, want ${CSV_HEADER.length}`,
      );
    }
    const field = (column: (typeof CSV_HEADER)[number]): string =>
      row[CSV_HEADER.indexOf(column)] ?? "";
    const feature = features[index];
    if (feature === undefined) throw new Error(`no feature ${index}`);
    const name = field("name").normalize("NFC").trim();
    const featureName = feature.properties.name.normalize("NFC").trim();
    if (name !== featureName) {
      throw new Error(
        `Row ${index + 1}: ${CSV_NAME} says "${name}" but ${GEOJSON_NAME} says "${featureName}"`,
      );
    }
    const date = field("date");
    if (Number.isNaN(Date.parse(date))) {
      throw new Error(`Row ${index + 1} ("${name}"): bad date "${date}"`);
    }
    const [lng, lat] = feature.geometry.coordinates;
    return {
      index,
      name,
      address: field("address").trim(),
      lat,
      lng,
      date,
      note: field("userComment").trim(),
      tags: [
        ...new Set(
          field("tags")
            .split("#")
            .map((tag) => tag.normalize("NFC").trim())
            .filter((tag) => tag !== ""),
        ),
      ],
    };
  });
}
