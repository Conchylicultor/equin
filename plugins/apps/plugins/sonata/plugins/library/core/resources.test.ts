/**
 * The song library's fields, derived from the songs entity and the list's own
 * two columns: the ids the library's saved views, sort presets and filter
 * presets name are unchanged, the sortable ones are exactly what the server
 * binds, and the rows reach the songs entity (every exposure of it folds in —
 * playback-history's plays, the MIDI source's tracks and file flag).
 *
 * Run: `./singularity test plugins/apps/plugins/sonata/plugins/library`.
 */

import { describe, expect, test } from "bun:test";
import { songLibrary } from "./resources";

/** The ids the library named before its fields were derived — saved views name them. */
const LIST_FIELD_IDS = ["title", "composer", "source", "duration", "added"];

describe("song library fields", () => {
  test("derives the persisted field ids, in list order", () => {
    expect(Object.keys(songLibrary.fields)).toEqual(LIST_FIELD_IDS);
    expect([...songLibrary.sortable] as string[]).toEqual(LIST_FIELD_IDS);
    expect(Object.keys(songLibrary.filterable)).toEqual(LIST_FIELD_IDS);
    expect(songLibrary.columnScope).toBe("sonata.library");
  });

  test("labels and the title field come from the entity; the own fields carry theirs", () => {
    const f = songLibrary.fields;
    expect(f.title).toMatchObject({ label: "Title", primary: true });
    expect(f.source).toMatchObject({ label: "Source", domain: "text" });
    expect(f.duration).toMatchObject({ label: "Length", domain: "number" });
    expect(f.added).toMatchObject({ label: "Added", domain: "instant" });
  });

  test("the row carries the id, and reaches the songs entity", () => {
    expect([...songLibrary.rowKeys] as string[]).toEqual([
      ...LIST_FIELD_IDS,
      "id",
    ]);
    expect(Object.values(songLibrary.exposes ?? {}).map((r) => r.name)).toEqual(
      ["sonata_songs"],
    );
  });
});
