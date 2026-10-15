import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import {
  PlaceCandidateSchema,
  PlaceSnapshotSchema,
  type PlaceSnapshot,
} from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";
import type { MapstrPlace } from "./export";
import { MatchDecisionSchema, type MatchDecision } from "./match";

// `mapstr-matches.json`: per Mapstr place, every Google search made for it (so
// changing the scorer re-decides without paying Google again), the scorer's
// decision, and an optional hand-written `override` that wins over it — a
// re-score never touches an override. `--apply` reads it back.

const SearchSchema = z.object({
  /** The language asked for; absent for the default (Google's choice). */
  languageCode: z.string().optional(),
  /** Searched by the name alone; absent for "<name>, <address>". */
  nameOnly: z.boolean().optional(),
  candidates: z.array(PlaceCandidateSchema),
});

/**
 * A human's (or a research agent's) call on a row, one of three — told apart
 * by their keys (`.strict()`, so no entry can be two at once):
 *
 * - **Google**: this Google place — with the evidence, the details snapshot
 *   `--overrides` validated it with (so `--apply` does not fetch it again),
 *   and optionally the user's own `title`, shown instead of Google's name.
 * - **Custom**: no Google place — a custom place named `custom.name`, pinned
 *   at `custom.lat` / `lng` (the Mapstr pin when the entry gave none).
 * - **Discard**: the user chose to drop the row, for `reason`. The one way a
 *   row is left out, and `--apply` lists every one.
 */
const GoogleOverrideSchema = z
  .object({
    googlePlaceId: z.string().min(1),
    title: z.string().trim().min(1).optional(),
    note: z.string().optional(),
    snapshot: PlaceSnapshotSchema.optional(),
  })
  .strict();

const CustomOverrideSchema = z
  .object({
    custom: z
      .object({
        name: z.string().trim().min(1),
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
      })
      .strict(),
    note: z.string().optional(),
  })
  .strict();

const DiscardOverrideSchema = z
  .object({
    discard: z.literal(true),
    reason: z.string().trim().min(1),
  })
  .strict();

const OverrideSchema = z.union([
  GoogleOverrideSchema,
  CustomOverrideSchema,
  DiscardOverrideSchema,
]);

export type Override = z.infer<typeof OverrideSchema>;

const MatchRowSchema = z.object({
  index: z.number().int().nonnegative(),
  name: z.string(),
  address: z.string(),
  tags: z.array(z.string()),
  searches: z.array(SearchSchema),
  decision: MatchDecisionSchema,
  override: OverrideSchema.optional(),
  /** Set when an earlier row resolves to the same Google place: that row wins. */
  duplicateOf: z.number().int().optional(),
});

const MATCHES_FILE_VERSION = 2;

const MatchesFileSchema = z.object({
  version: z.literal(MATCHES_FILE_VERSION),
  /** sha256 of the export's mapstr.csv; `--apply` refuses any other export. */
  inputSha256: z.string(),
  rows: z.array(MatchRowSchema),
});

export type Search = z.infer<typeof SearchSchema>;
export type MatchRow = z.infer<typeof MatchRowSchema>;
export type MatchesFile = z.infer<typeof MatchesFileSchema>;

export async function readMatchesFile(path: string): Promise<MatchesFile> {
  const json: unknown = JSON.parse(await readFile(path, "utf8"));
  const version = z.object({ version: z.number() }).safeParse(json);
  if (version.success && version.data.version !== MATCHES_FILE_VERSION) {
    throw new Error(
      `${path} is a version ${version.data.version} matches file (no stored searches); re-run with --refresh to rebuild it`,
    );
  }
  return MatchesFileSchema.parse(json);
}

export async function writeMatchesFile(
  path: string,
  rows: readonly MatchRow[],
  inputSha256: string,
): Promise<void> {
  const file: MatchesFile = {
    version: MATCHES_FILE_VERSION,
    inputSha256,
    rows: markDuplicates(rows),
  };
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`);
}

/** What a row resolves to: its override when a human set one, else the scorer's decision. */
export type Resolution =
  | {
      kind: "matched";
      googlePlaceId: string;
      byHand: boolean;
      /** The user's own name for it, shown instead of Google's. */
      title?: string;
      /** The details an override was validated with; fetched at --apply otherwise. */
      snapshot?: PlaceSnapshot;
    }
  /** No Google place: imported as a custom place. */
  | { kind: "custom"; name: string; lat: number; lng: number }
  /** Left out on purpose. */
  | { kind: "discarded"; reason: string }
  | { kind: "unmatched"; reason: string };

export function resolveRow(row: MatchRow): Resolution {
  const { override, decision } = row;
  if (override !== undefined) {
    if ("custom" in override) return { kind: "custom", ...override.custom };
    if ("discard" in override) {
      return { kind: "discarded", reason: override.reason };
    }
    return {
      kind: "matched",
      googlePlaceId: override.googlePlaceId,
      byHand: true,
      ...(override.title === undefined ? {} : { title: override.title }),
      ...(override.snapshot === undefined
        ? {}
        : { snapshot: override.snapshot }),
    };
  }
  return decision.kind === "matched"
    ? { kind: "matched", googlePlaceId: decision.googlePlaceId, byHand: false }
    : decision;
}

/**
 * Marks every row resolving to a Google place an earlier row already resolved
 * to (Mapstr saves of one place under two names): the first keeps it.
 */
export function markDuplicates(rows: readonly MatchRow[]): MatchRow[] {
  const firstByGoogleId = new Map<string, number>();
  return [...rows]
    .sort((a, b) => a.index - b.index)
    .map((row) => {
      const { duplicateOf: _stale, ...rest } = row;
      const resolved = resolveRow(rest);
      if (resolved.kind !== "matched") return rest;
      const first = firstByGoogleId.get(resolved.googlePlaceId);
      if (first === undefined) {
        firstByGoogleId.set(resolved.googlePlaceId, rest.index);
        return rest;
      }
      return { ...rest, duplicateOf: first };
    });
}

/**
 * The rows of `file` that still describe `places`, by index — refusing a file
 * made from another export, or one whose row no longer names the same place.
 * A place with no row has not been searched yet.
 */
export function rowsFor(
  file: MatchesFile,
  places: readonly MapstrPlace[],
  csvSha256: string,
): Map<number, MatchRow> {
  if (file.inputSha256 !== csvSha256) {
    throw new Error(
      "The matches file was made from a different Mapstr export (its mapstr.csv differs). Re-run without --apply and with --refresh, or pass --out to start a new file.",
    );
  }
  const byIndex = new Map<number, MatchRow>();
  for (const row of file.rows) {
    const place = places[row.index];
    if (place === undefined || place.name !== row.name) {
      throw new Error(
        `Matches file row ${row.index} ("${row.name}") does not match the export's row ("${place?.name ?? "none"}")`,
      );
    }
    byIndex.set(row.index, row);
  }
  return byIndex;
}

/** A matches-file row for `place`, keeping a previous row's override. */
export function matchRow(
  place: MapstrPlace,
  searches: readonly Search[],
  decision: MatchDecision,
  override?: MatchRow["override"],
): MatchRow {
  return {
    index: place.index,
    name: place.name,
    address: place.address,
    tags: place.tags,
    searches: [...searches],
    decision,
    ...(override === undefined ? {} : { override }),
  };
}
