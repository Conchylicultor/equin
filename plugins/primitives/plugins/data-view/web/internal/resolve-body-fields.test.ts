/**
 * `resolveBodyFields` is the ONE seam that decides which fields a view prints.
 * It has two inputs — the schema's own `FieldDef.visible` default and the view
 * instance's `properties` list — and the interesting claim is what it does
 * NOT do: it never touches the schema the sort / filter / search pipeline runs
 * over, because every view calls it after that pipeline, on a separate value.
 */
import { describe, expect, test } from "bun:test";
import type { FieldDef } from "../../core";
import { resolveBodyFields } from "./resolve-body-fields";

type Row = { id: string };

const FIELDS: FieldDef<Row>[] = [
  { id: "name", label: "Name", value: (r) => r.id, primary: true },
  { id: "status", label: "Status", type: "enum", value: () => "ok" },
  // Declared as a dimension, not as something to print.
  {
    id: "enabled",
    label: "Enabled",
    type: "bool",
    value: () => true,
    visible: false,
  },
];

const ids = (fields: FieldDef<Row>[]) => fields.map((f) => f.id);

describe("resolveBodyFields", () => {
  test("drops a `visible: false` field from the unconfigured default body set", () => {
    expect(ids(resolveBodyFields(FIELDS, null))).toEqual(["name", "status"]);
    expect(ids(resolveBodyFields(FIELDS, undefined))).toEqual([
      "name",
      "status",
    ]);
  });

  test("prints a `visible: false` field when a view's array names it", () => {
    // `visible` is a DEFAULT, not an enforcement: once the user switches the
    // field on, the explicit array is the whole answer.
    expect(
      ids(resolveBodyFields(FIELDS, [{ id: "enabled" }, { id: "name" }])),
    ).toEqual(["enabled", "name"]);
  });

  test("leaves out hidden entries and fields the array does not list", () => {
    // `status` is listed hidden (it keeps its place in Properties); `enabled`
    // is not listed at all — a field added after the view was customized —
    // and arrives hidden too.
    expect(
      ids(
        resolveBodyFields(FIELDS, [
          { id: "status", hidden: true },
          { id: "name" },
        ]),
      ),
    ).toEqual(["name"]);
  });

  test("never removes the field from the schema it was handed", () => {
    // The sort / filter / search pipeline runs over `props.fields`; this helper
    // returns a NEW list and leaves its input alone, which is what makes a
    // hidden field still filterable and sortable.
    resolveBodyFields(FIELDS, null);
    expect(ids(FIELDS)).toEqual(["name", "status", "enabled"]);
  });

  test("an explicit array comes back band by band, not in the order stored", () => {
    // The Properties list draws one band per source and IS the body order, so a
    // stored order that interleaves two bands is regrouped rather than obeyed
    // — within a band the stored order still decides.
    const sectioned: FieldDef<Row>[] = [
      ...FIELDS,
      { id: "build.status", label: "Build status", section: "Build" },
      { id: "build.targets", label: "Targets", section: "Build" },
    ];
    expect(
      ids(
        resolveBodyFields(sectioned, [
          { id: "build.targets" },
          { id: "name" },
          { id: "build.status" },
          { id: "status" },
        ]),
      ),
    ).toEqual(["name", "status", "build.targets", "build.status"]);
  });

  test("an absent `visible` reads as true (custom columns need no change)", () => {
    const withCustom: FieldDef<Row>[] = [
      ...FIELDS,
      { id: "custom", label: "Custom", value: () => "x" },
    ];
    expect(ids(resolveBodyFields(withCustom, null))).toContain("custom");
  });
});
