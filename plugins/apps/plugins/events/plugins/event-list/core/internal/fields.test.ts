/**
 * The events list's fields, derived from the `events` entity: the ids the
 * list (and every saved view) named before are unchanged — `sourceId` (the
 * source dimension, once contributed) included — plus `description`, listed
 * so the search box matches it; the sortable ones are `EVENT_LIST_SORTABLE`;
 * every search column is filterable text.
 *
 * Run: `./singularity test plugins/apps/plugins/events/plugins/event-list`.
 */

import { describe, expect, test } from "bun:test";
import { eventsList } from "./collection";
import { EVENT_LIST_SEARCHABLE, EVENT_LIST_SORTABLE } from "./fields";

/** The ids the list named before its fields were derived — saved views name them. */
const LIST_FIELD_IDS = [
  "title",
  "startsAt",
  "category",
  "venue",
  "city",
  "price",
  "recurring",
  "tags",
  "url",
  "disappearedAt",
  "sourceId",
];

describe("events list fields", () => {
  test("derives the list's ids, in order, then the search-only description", () => {
    expect(Object.keys(eventsList.fields)).toEqual([
      ...LIST_FIELD_IDS,
      "description",
    ]);
    expect([...eventsList.sortable]).toEqual([...EVENT_LIST_SORTABLE]);
    expect(eventsList.columnScope).toBe("events.list");
  });

  test("labels, types and options come from the entity", () => {
    const f = eventsList.fields;
    expect(f.title).toMatchObject({ label: "Title", primary: true });
    expect(f.startsAt).toMatchObject({ label: "When", domain: "instant" });
    expect(f.category.options).toMatchObject({ music: { label: "Music" } });
    expect(f.tags).toMatchObject({ typeId: "tags", domain: "stringArray" });
    expect(f.recurring.domain).toBe("boolean");
    expect(f.sourceId).toMatchObject({ label: "Source", domain: "text" });
  });

  test("every search column is filterable text", () => {
    for (const c of EVENT_LIST_SEARCHABLE) {
      expect(eventsList.filterable[c].domain).toBe("text");
    }
  });
});
