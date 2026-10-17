/**
 * A schema's sections are what let one merged surface's forty columns read as
 * five short lists. The two claims worth pinning are that a schema nobody
 * sectioned comes back untouched (so every existing DataView keeps its flat
 * list), and that ordering by section is a REGROUPING, never a re-sorting —
 * within a band the author's order survives.
 */
import { describe, expect, test } from "bun:test";
import type { FieldDef } from "./types";
import {
  orderFieldsBySection,
  splitFieldSections,
  SHARED_FIELD_SECTION,
} from "./field-sections";

type Row = { id: string };

const field = (id: string, section?: string): FieldDef<Row> => ({
  id,
  label: id,
  ...(section ? { section } : {}),
});

const ids = (fields: FieldDef<Row>[]) => fields.map((f) => f.id);

describe("splitFieldSections", () => {
  test("an unsectioned schema is ONE band, so surfaces draw no heading", () => {
    const sections = splitFieldSections([field("a"), field("b")]);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.id).toBeNull();
    expect(sections[0]!.label).toBe(SHARED_FIELD_SECTION);
    expect(ids(sections[0]!.fields)).toEqual(["a", "b"]);
  });

  test("bands come in first-appearance order, the host's own first", () => {
    const sections = splitFieldSections([
      field("label"),
      field("kind"),
      field("build.status", "Build"),
      field("deploy.verb", "Deploy"),
      field("build.targets", "Build"),
    ]);
    expect(sections.map((s) => s.label)).toEqual([
      SHARED_FIELD_SECTION,
      "Build",
      "Deploy",
    ]);
    expect(ids(sections[1]!.fields)).toEqual(["build.status", "build.targets"]);
  });
});

describe("orderFieldsBySection", () => {
  test("regroups scattered bands into contiguous runs", () => {
    const ordered = orderFieldsBySection([
      field("build.status", "Build"),
      field("label"),
      field("deploy.verb", "Deploy"),
      field("kind"),
      field("build.targets", "Build"),
    ]);
    // Bands in first-appearance order; within each, the order given.
    expect(ids(ordered)).toEqual([
      "build.status",
      "build.targets",
      "label",
      "kind",
      "deploy.verb",
    ]);
  });

  test("bands are ordered by the SCHEMA, not by the subset being ordered", () => {
    const schema = [
      field("label"),
      field("kind"),
      field("build.status", "Build"),
      field("deploy.verb", "Deploy"),
    ];
    // A stored `properties` order that happens to start with an arm's column
    // must not float that arm's band above the host's own.
    const stored = [
      field("deploy.verb", "Deploy"),
      field("build.status", "Build"),
      field("kind"),
    ];
    expect(ids(orderFieldsBySection(stored, schema))).toEqual([
      "kind",
      "build.status",
      "deploy.verb",
    ]);
  });

  test("leaves an unsectioned list exactly as it was", () => {
    const fields = [field("c"), field("a"), field("b")];
    expect(ids(orderFieldsBySection(fields))).toEqual(["c", "a", "b"]);
  });
});
