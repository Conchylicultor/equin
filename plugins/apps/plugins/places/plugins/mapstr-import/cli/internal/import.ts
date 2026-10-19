import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { dirname, join, resolve } from "node:path";
import { replaceAllPlaces } from "@plugins/apps/plugins/places/plugins/places-core/server";
import {
  placeDetails,
  searchText,
} from "@plugins/integrations/plugins/google-maps/plugins/places-api/server";
import {
  PlacesApiError,
  type PlaceSnapshot,
  type PlacesClient,
} from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";
import { createSemaphore } from "@plugins/packages/plugins/semaphore/core";
import { readMapstrExport, type MapstrPlace } from "./export";
import { requirePlacesClient, underQuota } from "./google";
import { languageForAddress, pickCandidate, type MatchDecision } from "./match";
import {
  markDuplicates,
  matchRow,
  readMatchesFile,
  resolveRow,
  rowsFor,
  writeMatchesFile,
  type MatchRow,
  type Override,
  type Search,
} from "./matches-file";
import type { ImportMapstrOptions } from "./options";
import { mergeImports, type ResolvedRow } from "./merge";
import { unknownMapstrTags } from "./tag-map";

/** Google calls in flight at once — polite to the quota, ~4x a serial run. */
const CONCURRENCY = 4;
/** The Text Search location bias around the Mapstr pin. */
const BIAS_RADIUS_M = 250;
const MATCHES_FILE = "mapstr-matches.json";

export async function importMapstr(
  rawPath: string,
  opts: ImportMapstrOptions,
  namespace: string,
): Promise<void> {
  const input = resolve(rawPath);
  const matchesPath =
    opts.out !== undefined
      ? resolve(opts.out)
      : join(
          (await stat(input)).isDirectory() ? input : dirname(input),
          MATCHES_FILE,
        );
  const { places, csvSha256 } = await readMapstrExport(input);
  console.log(`${input}: ${places.length} places`);

  // Before any Google call: a tag nobody mapped fails now, not at --apply.
  const unknown = unknownMapstrTags(places.flatMap((p) => p.tags));
  if (unknown.length > 0) {
    throw new Error(
      `Mapstr tags with no mapping in MAPSTR_TAGS: ${unknown.map((t) => `"${t}"`).join(", ")}`,
    );
  }

  if (opts.apply) {
    if (opts.refresh || opts.rescore || opts.overrides !== undefined) {
      throw new Error(
        "--apply only writes the reviewed file: drop --refresh / --rescore / --overrides",
      );
    }
    await apply(places, csvSha256, matchesPath, namespace);
  } else {
    await match(places, csvSha256, matchesPath, {
      refresh: opts.refresh === true,
      rescore: opts.rescore === true,
      ...(opts.overrides === undefined
        ? {}
        : { overridesPath: opts.overrides }),
    });
  }
}

// ── Phase A: match ──────────────────────────────────────────────────────────

async function match(
  places: readonly MapstrPlace[],
  csvSha256: string,
  matchesPath: string,
  {
    refresh,
    rescore,
    overridesPath,
  }: { refresh: boolean; rescore: boolean; overridesPath?: string },
): Promise<void> {
  if (refresh && rescore) {
    throw new Error("--rescore never searches: drop --refresh");
  }
  const stored = existsSync(matchesPath)
    ? rowsFor(await readMatchesFile(matchesPath), places, csvSha256)
    : new Map<number, MatchRow>();
  // --refresh forgets the searches, never a human's decision.
  const previous = refresh
    ? new Map(
        [...stored].map(([index, row]) => [
          index,
          { ...row, searches: [] as Search[] },
        ]),
      )
    : stored;
  console.log(
    `${stored.size} rows in ${matchesPath}${refresh ? " (searches discarded)" : ""}${rescore ? " (re-scoring only, no Google call)" : ""}`,
  );

  let client: Promise<PlacesClient> | undefined;
  const placesClient = () => (client ??= requirePlacesClient());

  const overrides =
    overridesPath === undefined
      ? new Map<number, Override>()
      : await validateOverrides(overridesPath, places, placesClient);

  const rows = new Map<number, MatchRow>();
  let calls = 0;
  const search = async (
    place: MapstrPlace,
    { languageCode, nameOnly }: { languageCode?: string; nameOnly?: boolean },
  ): Promise<Search> => {
    const k = await placesClient();
    const query = nameOnly ? place.name : `${place.name}, ${place.address}`;
    const candidates = await underQuota(() =>
      searchText(k, query, {
        bias: {
          kind: "circle",
          lat: place.lat,
          lng: place.lng,
          radiusM: BIAS_RADIUS_M,
        },
        ...(languageCode === undefined ? {} : { languageCode }),
      }),
    );
    calls++;
    if (calls % 50 === 0) console.log(`  ${calls} Google searches`);
    return {
      ...(languageCode === undefined ? {} : { languageCode }),
      ...(nameOnly ? { nameOnly: true } : {}),
      candidates,
    };
  };

  const gate = createSemaphore(CONCURRENCY);
  try {
    await Promise.all(
      places.map((place) =>
        gate.run(async () => {
          const prev = previous.get(place.index);
          const override = overrides.get(place.index) ?? prev?.override;
          const searches = [...(prev?.searches ?? [])];
          const language = languageForAddress(place.address);
          // The searches to try, in order, each only while still unmatched:
          // "<name>, <address>"; again in the place's own language (Google
          // otherwise names it in English); then the name alone (the address
          // search found only the street), in both languages.
          const plan: { languageCode?: string; nameOnly?: boolean }[] = [
            {},
            ...(language === undefined ? [] : [{ languageCode: language }]),
            { nameOnly: true },
            ...(language === undefined
              ? []
              : [{ languageCode: language, nameOnly: true }]),
          ];
          let decision: MatchDecision | undefined;
          for (const step of plan) {
            const done = searches.some(
              (s) =>
                s.languageCode === step.languageCode &&
                (s.nameOnly ?? false) === (step.nameOnly ?? false),
            );
            if (!done) {
              // --rescore never searches; a decided row needs no more searches.
              if (rescore || override !== undefined) break;
              searches.push(await search(place, step));
            }
            decision = pickCandidate(place, searches);
            if (decision.kind === "matched") break;
          }
          // Overridden before any search: the row exists for its override.
          decision ??= pickCandidate(place, searches);
          if (searches.length === 0 && override === undefined) return;
          rows.set(place.index, matchRow(place, searches, decision, override));
        }),
      ),
    );
  } finally {
    // Keep what was searched: a re-run resumes instead of paying again. A row
    // this run did not reach keeps its previous state.
    for (const [index, row] of previous) {
      if (!rows.has(index)) rows.set(index, row);
    }
    await writeMatchesFile(matchesPath, [...rows.values()], csvSha256);
  }
  console.log(`${calls} Google searches made`);
  report(markDuplicates([...rows.values()]), places.length, matchesPath);
}

/**
 * One entry of an `--overrides` file: a Google place (optionally under the
 * user's title), a custom place (its pin defaults to the Mapstr pin), or a row
 * the user chose to drop, with why. `.strict()`: an entry is exactly one.
 */
const OverrideEntrySchema = z.union([
  z
    .object({
      index: z.number().int().nonnegative(),
      googlePlaceId: z.string().min(1),
      title: z.string().trim().min(1).optional(),
      note: z.string().optional(),
    })
    .strict(),
  z
    .object({
      index: z.number().int().nonnegative(),
      custom: z
        .object({
          name: z.string().trim().min(1),
          lat: z.number().min(-90).max(90).optional(),
          lng: z.number().min(-180).max(180).optional(),
        })
        .strict()
        .refine((c) => (c.lat === undefined) === (c.lng === undefined), {
          message: "give both lat and lng, or neither (the Mapstr pin)",
        }),
      note: z.string().optional(),
    })
    .strict(),
  z
    .object({
      index: z.number().int().nonnegative(),
      discard: z.literal(true),
      reason: z.string().trim().min(1),
    })
    .strict(),
]);

type OverrideEntry = z.infer<typeof OverrideEntrySchema>;

/**
 * Reads an `--overrides` file. A custom or discard entry is recorded as is (a
 * custom pin defaulting to the Mapstr one); a Google id is checked with one
 * Place Details call, keeping the snapshot so `--apply` does not fetch it
 * again. An id Google refuses is reported and not recorded; the rest are.
 */
async function validateOverrides(
  path: string,
  places: readonly MapstrPlace[],
  placesClient: () => Promise<PlacesClient>,
): Promise<Map<number, Override>> {
  const entries = z
    .array(OverrideEntrySchema)
    .parse(JSON.parse(await readFile(resolve(path), "utf8")));
  const out = new Map<number, Override>();
  const failures: string[] = [];
  const gate = createSemaphore(CONCURRENCY);
  await Promise.all(
    entries.map((entry) =>
      gate.run(async () => {
        const place = places[entry.index];
        if (place === undefined) {
          failures.push(`#${entry.index}: no such row in the export`);
          return;
        }
        const recorded = await overrideFor(entry, place, placesClient);
        if (recorded.ok) out.set(entry.index, recorded.override);
        else failures.push(`#${entry.index} ${place.name}: ${recorded.reason}`);
      }),
    ),
  );
  console.log(
    `${out.size} of ${entries.length} overrides recorded from ${path}`,
  );
  for (const line of failures) console.log(`  NOT recorded: ${line}`);
  return out;
}

/** The override an entry records, or why it cannot be. */
async function overrideFor(
  entry: OverrideEntry,
  place: MapstrPlace,
  placesClient: () => Promise<PlacesClient>,
): Promise<{ ok: true; override: Override } | { ok: false; reason: string }> {
  if ("discard" in entry) {
    return { ok: true, override: { discard: true, reason: entry.reason } };
  }
  const note = entry.note === undefined ? {} : { note: entry.note };
  if ("custom" in entry) {
    const { name, lat, lng } = entry.custom;
    return {
      ok: true,
      override: {
        custom: { name, lat: lat ?? place.lat, lng: lng ?? place.lng },
        ...note,
      },
    };
  }
  const k = await placesClient();
  const details = await underQuota(() =>
    placeDetails(k, entry.googlePlaceId),
  ).then(
    (snapshot) => ({ ok: true as const, snapshot }),
    (err: unknown) => {
      // A refused id (NOT_FOUND, INVALID_ARGUMENT) is the human's to fix;
      // anything else is a broken run.
      if (err instanceof PlacesApiError && err.status !== 429) {
        return {
          ok: false as const,
          reason: `${entry.googlePlaceId} refused by Google (${err.status} ${err.message})`,
        };
      }
      throw err;
    },
  );
  if (!details.ok) return details;
  const { snapshot } = details;
  if (snapshot.lat === undefined || snapshot.lng === undefined) {
    return {
      ok: false,
      reason: `${entry.googlePlaceId} ("${snapshot.name}") has no location`,
    };
  }
  return {
    ok: true,
    override: {
      googlePlaceId: snapshot.placeId,
      ...(entry.title === undefined ? {} : { title: entry.title }),
      ...note,
      snapshot,
    },
  };
}

/** Below this similarity, or beyond this distance, an accepted match is worth a look. */
const DOUBTFUL_SIMILARITY = 0.75;
const DOUBTFUL_DISTANCE_M = 300;

function report(
  rows: readonly MatchRow[],
  total: number,
  matchesPath: string,
): void {
  const resolved = rows.map((row) => ({ row, resolution: resolveRow(row) }));
  const matched = resolved.filter(
    (r) => r.resolution.kind === "matched" && r.row.duplicateOf === undefined,
  );
  const duplicates = resolved.filter((r) => r.row.duplicateOf !== undefined);
  const custom = resolved.filter((r) => r.resolution.kind === "custom");
  const discarded = resolved.filter((r) => r.resolution.kind === "discarded");
  const unmatched = resolved.filter((r) => r.resolution.kind === "unmatched");
  const unsearched = total - rows.length;
  console.log(
    `\n${matched.length} matched, ${duplicates.length} duplicates, ${custom.length} custom, ${discarded.length} discarded, ${unmatched.length} unmatched${unsearched > 0 ? `, ${unsearched} not searched yet` : ""} → ${matchesPath}`,
  );
  for (const { row } of duplicates) {
    console.log(
      `  duplicate: #${row.index} "${row.name}" = #${row.duplicateOf}`,
    );
  }

  const doubtful = matched.filter(
    ({ row }) =>
      row.override === undefined &&
      row.decision.kind === "matched" &&
      (row.decision.similarity < DOUBTFUL_SIMILARITY ||
        row.decision.distanceM > DOUBTFUL_DISTANCE_M ||
        row.decision.basis === "translation"),
  );
  if (doubtful.length > 0) {
    console.log(
      `\nDoubtful matches (name < ${DOUBTFUL_SIMILARITY * 100}%, > ${DOUBTFUL_DISTANCE_M} m, or taken as a translation):`,
    );
    for (const { row } of doubtful) {
      if (row.decision.kind !== "matched") continue;
      console.log(
        `  #${row.index} ${row.name} → "${row.decision.googleName}" (${row.decision.distanceM} m, name ${Math.round(row.decision.similarity * 100)}%, by ${row.decision.basis ?? "name"})`,
      );
    }
  }

  for (const { row, resolution } of custom) {
    if (resolution.kind !== "custom") continue;
    console.log(
      `  custom: #${row.index} "${row.name}" as "${resolution.name}"`,
    );
  }
  for (const { row, resolution } of discarded) {
    if (resolution.kind !== "discarded") continue;
    console.log(
      `  discarded: #${row.index} "${row.name}": ${resolution.reason}`,
    );
  }
  if (unmatched.length > 0) {
    console.log(
      `\nUnmatched (decide each with --overrides <file.json> — a Google id, a custom place or a discard; find ids with ./singularity places search-place):`,
    );
    for (const { row, resolution } of unmatched) {
      if (resolution.kind !== "unmatched") continue;
      console.log(
        `  #${row.index} ${row.name} — ${row.address} [${row.tags.join(", ")}]: ${resolution.reason}`,
      );
    }
  }
  console.log(
    `\nReview, then: ./singularity places import-mapstr <path> --apply`,
  );
}

// ── Phase B: apply ──────────────────────────────────────────────────────────

async function apply(
  places: readonly MapstrPlace[],
  csvSha256: string,
  matchesPath: string,
  namespace: string,
): Promise<void> {
  if (!existsSync(matchesPath)) {
    throw new Error(
      `No matches file at ${matchesPath}: run without --apply first`,
    );
  }
  const decisions = rowsFor(
    await readMatchesFile(matchesPath),
    places,
    csvSha256,
  );
  const missing = places.filter((p) => !decisions.has(p.index));
  if (missing.length > 0) {
    throw new Error(
      `${missing.length} places were never searched (e.g. "${missing[0]?.name}"): finish phase A first`,
    );
  }

  // Nothing is left behind by accident: every row needs a decision before the
  // wipe — a Google place, a custom place, or an explicit discard.
  const unresolved: string[] = [];
  const discarded: string[] = [];
  const customs: ResolvedRow[] = [];
  const toFetch: {
    place: MapstrPlace;
    googlePlaceId: string;
    title?: string;
    snapshot?: PlaceSnapshot;
  }[] = [];
  for (const row of decisions.values()) {
    const place = places[row.index];
    if (place === undefined) throw new Error(`no place #${row.index}`);
    const resolution = resolveRow(row);
    switch (resolution.kind) {
      case "unmatched":
        unresolved.push(`#${row.index} ${row.name}: ${resolution.reason}`);
        continue;
      case "discarded":
        discarded.push(`#${row.index} ${row.name}: ${resolution.reason}`);
        continue;
      case "custom": {
        const { name, lat, lng } = resolution;
        customs.push({ place, source: { kind: "custom", name, lat, lng } });
        continue;
      }
      case "matched":
        toFetch.push({
          place,
          googlePlaceId: resolution.googlePlaceId,
          ...(resolution.title === undefined
            ? {}
            : { title: resolution.title }),
          ...(resolution.snapshot === undefined
            ? {}
            : { snapshot: resolution.snapshot }),
        });
    }
  }
  if (unresolved.length > 0) {
    throw new Error(
      `${unresolved.length} places have no decision yet — give each an override (--overrides: a Google id, a custom place, or a discard) first:\n  ${unresolved.join("\n  ")}`,
    );
  }

  // Every network call happens here, BEFORE the wipe: a Google failure leaves
  // the DB as it was.
  // (An override validated by --overrides carries its details already.)
  const toDownload = toFetch.filter((f) => f.snapshot === undefined).length;
  console.log(`Fetching Google details for ${toDownload} places…`);
  let client: Promise<PlacesClient> | undefined;
  const gate = createSemaphore(CONCURRENCY);
  let done = 0;
  // A stored id Google no longer knows (it re-keys places) is collected per
  // row, so one run names every row to re-decide.
  const refused: string[] = [];
  const results = await Promise.all(
    toFetch.map(({ place, googlePlaceId, title, snapshot: known }) =>
      gate.run(async (): Promise<ResolvedRow | undefined> => {
        const titled = title === undefined ? {} : { title };
        if (known !== undefined) {
          return {
            place,
            source: { kind: "google", snapshot: known, ...titled },
          };
        }
        const k = await (client ??= requirePlacesClient());
        const snapshot = await underQuota(() =>
          placeDetails(k, googlePlaceId),
        ).catch((err: unknown) => {
          if (err instanceof PlacesApiError && err.status === 404) {
            refused.push(
              `#${place.index} ${place.name}: ${googlePlaceId} (${err.message})`,
            );
            return undefined;
          }
          throw err;
        });
        if (snapshot === undefined) return undefined;
        done++;
        if (done % 50 === 0) console.log(`  fetched ${done}/${toDownload}`);
        return { place, source: { kind: "google", snapshot, ...titled } };
      }),
    ),
  );
  if (refused.length > 0) {
    throw new Error(
      `Google no longer knows ${refused.length} stored ids — give each row an override (--overrides), then --apply again:\n  ${refused.join("\n  ")}`,
    );
  }
  const fetched = results.filter((r) => r !== undefined);

  for (const { place, source } of fetched) {
    if (source.kind !== "google") continue;
    const { snapshot } = source;
    if (snapshot.lat === undefined || snapshot.lng === undefined) {
      throw new Error(
        `#${place.index} ${place.name}: Google gave ${snapshot.placeId} no location — override it`,
      );
    }
  }
  const imported = mergeImports([...fetched, ...customs]);

  console.log(
    `Replacing every place and tag in ${namespace}'s database with the seed tree and ${imported.length} places…`,
  );
  const inserted = await replaceAllPlaces(imported);
  console.log(
    `\nImported ${inserted.length} places from ${fetched.length + customs.length} Mapstr rows: ${fetched.length} on Google (rows sharing a Google place merged), ${customs.length} custom; an icon job queued for each`,
  );
  console.log(`\nDiscarded ${discarded.length} rows, as decided:`);
  for (const line of discarded) console.log(`  ${line}`);
}
