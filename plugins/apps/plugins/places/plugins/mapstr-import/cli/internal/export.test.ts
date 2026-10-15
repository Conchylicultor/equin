import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { parseMapstrExport, readMapstrExport } from "./export";
import { readZipEntries } from "./zip";

// Real-shaped rows (from a Mapstr export): a multi-line comment, a repeated
// tag, an accented tag, a curly apostrophe.
const CSV = [
  "date,name,address,icon,userComment,rating,tags,photos",
  `"2026-09-19T17:50:54.755Z","Buvette - Cantine de l'Académie du Climat","2 Pl. Baudoyer Paris 75004","cafe","Fait avec PA. Cours intérieur.","","Food/Snacks#.Done#Extérieur#To Try",""`,
  `"2026-03-14T12:41:17.986Z","CHEZ POM’","216 Rue Saint-Maur, 75010 Paris, France","restaurant","Cafe/Restaurant Bio `,
  `Comedy club 1er mercredi","","Food/Restaurant#.Done#To Try#To Try",""`,
  "",
].join("\n");

const GEOJSON = JSON.stringify({
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [2.355872, 48.85633] },
      properties: { name: "Buvette - Cantine de l'Académie du Climat" },
    },
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [2.3706528, 48.8735208] },
      properties: { name: "CHEZ POM’", tags: [{ name: "Food/Restaurant" }] },
    },
  ],
});

test("joins the CSV and GeoJSON rows", () => {
  expect(parseMapstrExport(CSV, GEOJSON)).toEqual([
    {
      index: 0,
      name: "Buvette - Cantine de l'Académie du Climat",
      address: "2 Pl. Baudoyer Paris 75004",
      lat: 48.85633,
      lng: 2.355872,
      date: "2026-09-19T17:50:54.755Z",
      note: "Fait avec PA. Cours intérieur.",
      tags: ["Food/Snacks", ".Done", "Extérieur", "To Try"],
    },
    {
      index: 1,
      name: "CHEZ POM’",
      address: "216 Rue Saint-Maur, 75010 Paris, France",
      lat: 48.8735208,
      lng: 2.3706528,
      date: "2026-03-14T12:41:17.986Z",
      note: "Cafe/Restaurant Bio \nComedy club 1er mercredi",
      tags: ["Food/Restaurant", ".Done", "To Try"],
    },
  ]);
});

test("files from two exports refuse to join", () => {
  const swapped = GEOJSON.replace('"CHEZ POM’"', '"Other"');
  expect(() => parseMapstrExport(CSV, swapped)).toThrow(/says "CHEZ POM’"/);
  const short = JSON.stringify({
    type: "FeatureCollection",
    features: JSON.parse(GEOJSON).features.slice(1),
  });
  expect(() => parseMapstrExport(CSV, short)).toThrow(/2 places but/);
  expect(() =>
    parseMapstrExport(CSV.replace("date,", "when,"), GEOJSON),
  ).toThrow(/header/);
});

/** A zip of `files`, deflated, the way Mapstr ships its export. */
function zip(files: Record<string, string>): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text);
    const data = deflateRawSync(raw);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(dir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, eocd]);
}

test("the zip reader inflates every entry", () => {
  const entries = readZipEntries(
    zip({ "a.txt": "héllo", "dir/b.txt": "x".repeat(1000) }),
  );
  expect(new TextDecoder().decode(entries.get("a.txt"))).toBe("héllo");
  expect(entries.get("dir/b.txt")?.length).toBe(1000);
  expect(() => readZipEntries(new Uint8Array(100))).toThrow(/not a zip/);
});

test("reads the export from its zip or its folder, with the CSV's hash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mapstr-"));
  writeFileSync(
    join(dir, "mapstr.zip"),
    zip({ "mapstr.csv": CSV, "mapstr.geojson": GEOJSON }),
  );
  writeFileSync(join(dir, "mapstr.csv"), CSV);
  writeFileSync(join(dir, "mapstr.geojson"), GEOJSON);
  const fromZip = await readMapstrExport(join(dir, "mapstr.zip"));
  const fromDir = await readMapstrExport(dir);
  expect(fromZip).toEqual(fromDir);
  expect(fromZip.places).toHaveLength(2);
  expect(fromZip.csvSha256).toMatch(/^[0-9a-f]{64}$/);
});
