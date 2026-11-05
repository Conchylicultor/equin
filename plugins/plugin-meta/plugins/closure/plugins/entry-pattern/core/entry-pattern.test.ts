import { test, expect } from "bun:test";
import { parseEntryPattern } from "./entry-pattern";

// ── entry-pattern grammar: `.**` subtree opt-in + `!` negation ────────────────

test("parseEntryPattern splits negation / base / subtree", () => {
  expect(parseEntryPattern("apps.website")).toMatchObject({
    kind: "id",
    negate: false,
    base: "apps.website",
    subtree: false,
  });
  expect(parseEntryPattern("apps.website.**")).toMatchObject({
    kind: "id",
    negate: false,
    base: "apps.website",
    subtree: true,
  });
  expect(parseEntryPattern("!apps.website.demos.**")).toMatchObject({
    kind: "id",
    negate: true,
    base: "apps.website.demos",
    subtree: true,
  });
  // raw is preserved verbatim.
  expect(parseEntryPattern("!apps.website.demos.**").raw).toBe(
    "!apps.website.demos.**",
  );
});

// ── the root `**` pattern: every plugin ──────────────────────────────────────

test("parseEntryPattern recognises the root `**` form (and never throws on `!**`)", () => {
  expect(parseEntryPattern("**")).toEqual({
    kind: "root",
    negate: false,
    raw: "**",
  });
  // `!**` is a pathology the composition-closure check refuses — but PARSING it
  // must stay total, because Studio renders user-typed patterns.
  expect(parseEntryPattern("!**")).toEqual({
    kind: "root",
    negate: true,
    raw: "!**",
  });
});
