import { z } from "zod";
import { ReportKind, type ReportRow } from "@plugins/reports/server";

const UnknownTypePayloadSchema = z.object({
  primaryType: z.string(),
  placeName: z.string(),
});

type UnknownTypePayload = z.infer<typeof UnknownTypePayloadSchema>;

export const PLACE_GOOGLE_UNKNOWN_TYPE = "place-google-unknown-type";

/**
 * Google returned a `primaryType` the vendored Table A copy lacks. The card
 * still renders (a neutral circle), so this is a warning, deduped per type: the
 * fix is regenerating the copy, once, whichever places carry the type.
 */
export const unknownTypeKind = ReportKind({
  kind: PLACE_GOOGLE_UNKNOWN_TYPE,
  schema: UnknownTypePayloadSchema,
  fingerprint: (d: UnknownTypePayload) =>
    `${PLACE_GOOGLE_UNKNOWN_TYPE}:${d.primaryType}`,
  meta: {
    tag: "[place]",
    notif: "Unknown Google place type",
    variant: "warning",
  },
  renderTask: (row: ReportRow) => {
    const d = UnknownTypePayloadSchema.parse(row.data);
    return {
      title: `[place] Google place type "${d.primaryType}" is missing from Table A copy`,
      description: [
        `Google returned \`primaryType: "${d.primaryType}"\` (first seen on "${d.placeName}"), which is in neither table of`,
        "`plugins/page/plugins/place/plugins/google/server/internal/table-a.ts`, so the place card painted a neutral circle.",
        "",
        "Regenerate the copy:",
        "",
        "```",
        "./equin run plugins/page/plugins/place/plugins/google/scripts/fetch-table-a.ts",
        "```",
        "",
        `**Occurrences:** ${row.count}`,
      ].join("\n"),
    };
  },
});
