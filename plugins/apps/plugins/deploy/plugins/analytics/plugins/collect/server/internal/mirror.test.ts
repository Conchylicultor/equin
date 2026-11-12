import { describe, expect, test } from "bun:test";
import { defineMirrorSet } from "@plugins/database/plugins/table-mirror/plugins/source/server";
import { analyticsMirror } from "./mirror";
import { analyticsSalts, analyticsVisitorLinks } from "./tables";

// The salts and the visitor links make a visitor's hash reproducible from
// their IP: they must never leave the box.
describe("the analytics mirror set", () => {
  test("mirrors the visits, hits and rollups — never the salts or the visitor links", () => {
    expect(analyticsMirror.tables.map((t) => t.name).sort()).toEqual([
      "analytics_daily",
      "analytics_hits",
      "analytics_visit_members",
      "analytics_visits",
    ]);
  });

  test("listing a salt table in a set throws", () => {
    expect(() =>
      defineMirrorSet({
        id: "analytics_salts_probe",
        tables: [analyticsSalts],
      }),
    ).toThrow(/never|NeverMirrored/i);
    expect(() =>
      defineMirrorSet({
        id: "analytics_links_probe",
        tables: [analyticsVisitorLinks],
      }),
    ).toThrow(/never|NeverMirrored/i);
  });
});
