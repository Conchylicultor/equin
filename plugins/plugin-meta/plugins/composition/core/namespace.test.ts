/**
 * The composition-name vocabulary, and in particular THE SPLIT between the two
 * questions it answers:
 *
 *   - may a composition be CALLED this?      → `assertCompositionId`
 *   - may a composition be SERVED under it?  → `assertServableCompositionNamespace`
 *
 * The main composition and `base-exclusions` are the ids where those answers differ,
 * and that difference is what lets main become an ordinary manifest entry (and
 * the base row an ordinary negatives-only one) while their namespaces stay
 * off-limits to compose-serve. Pinned here so neither half can drift into the
 * other.
 */

import { test, expect } from "bun:test";
import {
  BASE_EXCLUSIONS_ID,
  MAIN_COMPOSITION_ID,
} from "@plugins/infra/plugins/namespace/core";
import {
  assertCompositionId,
  assertCompositionName,
  assertServableCompositionNamespace,
  isServableCompositionId,
  RESERVED_COMPOSITION_NAMESPACES,
} from "./namespace";

const BAD_NAMES = [
  "",
  "Sonata",
  "so nata",
  "-sonata",
  "so/nata",
  "so.nata",
  "a".repeat(64),
];

test("composition name validation rejects namespace-unsafe names", () => {
  expect(() => assertCompositionName("sonata")).not.toThrow();
  expect(() => assertCompositionName("a-1")).not.toThrow();
  expect(() => assertCompositionName(MAIN_COMPOSITION_ID)).not.toThrow();
  for (const bad of BAD_NAMES) {
    expect(() => assertCompositionName(bad)).toThrow(
      "Invalid composition name",
    );
  }
});

test("servable namespace validation additionally rejects the reserved namespaces", () => {
  expect(() => assertServableCompositionNamespace("sonata")).not.toThrow();
  expect([...RESERVED_COMPOSITION_NAMESPACES].sort()).toEqual([
    "base-exclusions",
    "central",
    "main",
    MAIN_COMPOSITION_ID,
  ]);
  for (const reserved of RESERVED_COMPOSITION_NAMESPACES) {
    expect(() => assertServableCompositionNamespace(reserved)).toThrow(
      "reserved namespace",
    );
  }
  expect(() => assertServableCompositionNamespace("So nata")).toThrow(
    "Invalid composition name",
  );
});

test("isServableCompositionId is the non-throwing twin of that assert", () => {
  expect(isServableCompositionId("sonata")).toBe(true);
  for (const reserved of RESERVED_COMPOSITION_NAMESPACES) {
    expect(isServableCompositionId(reserved)).toBe(false);
  }
  for (const bad of BAD_NAMES) expect(isServableCompositionId(bad)).toBe(false);
});

test("assertCompositionId accepts the named-but-unservable rows, assertServable still refuses them", () => {
  // The split. Main IS a composition — its id is legal in the manifest …
  expect(() => assertCompositionId(MAIN_COMPOSITION_ID)).not.toThrow();
  // … but its namespace belongs to main's own build, so it is never servable.
  expect(() => assertServableCompositionNamespace(MAIN_COMPOSITION_ID)).toThrow(
    "reserved namespace",
  );
  expect(isServableCompositionId(MAIN_COMPOSITION_ID)).toBe(false);

  // The base-exclusions row is the same shape of exception: an ordinary,
  // legally-named manifest row that holds only negatives, so its bundle is empty
  // and there is nothing a serve build could put behind the namespace.
  expect(() => assertCompositionId(BASE_EXCLUSIONS_ID)).not.toThrow();
  expect(() => assertServableCompositionNamespace(BASE_EXCLUSIONS_ID)).toThrow(
    "reserved namespace",
  );
  expect(isServableCompositionId(BASE_EXCLUSIONS_ID)).toBe(false);
});

test("assertCompositionId refuses the other reserved namespaces and bad names", () => {
  // Main and base-exclusions are the ONLY exceptions. `central` and `main` name
  // a runtime and a git branch — nothing may be called either, servable or not.
  for (const reserved of ["central", "main"]) {
    expect(() => assertCompositionId(reserved)).toThrow("reserved namespace");
  }
  expect(() => assertCompositionId("So nata")).toThrow(
    "Invalid composition name",
  );
  expect(() => assertCompositionId("sonata")).not.toThrow();
});
