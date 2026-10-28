import { describe, it, expect } from "vitest";
import {
  defineFieldIdentity,
  defineFieldType,
  type FieldIdentity,
} from "@plugins/fields/core";
import type { FieldDef } from "../../core";
import { isSearchable } from "../internal/use-flat-rows";

const text = defineFieldType<string>("text");
const code = defineFieldType<string>("code-ish");
const identities: ReadonlyMap<string, FieldIdentity> = new Map([
  [
    "code-ish",
    defineFieldIdentity<string>({ type: code, extends: text }) as FieldIdentity,
  ],
]);

const field = (type: string, extra: Partial<FieldDef<unknown>> = {}) =>
  ({ id: "f", label: "F", type, ...extra }) as FieldDef<unknown>;

describe("isSearchable", () => {
  it("reads the text, enum and tags bases", () => {
    for (const t of ["text", "enum", "tags"])
      expect(isSearchable(field(t), identities)).toBe(true);
    expect(isSearchable(field("number"), identities)).toBe(false);
  });

  it("reads a type that extends a searchable base", () => {
    expect(isSearchable(field("code-ish"), identities)).toBe(true);
  });

  it("honours an explicit filterable either way", () => {
    expect(
      isSearchable(field("number", { filterable: true }), identities),
    ).toBe(true);
    expect(
      isSearchable(field("code-ish", { filterable: false }), identities),
    ).toBe(false);
  });
});
