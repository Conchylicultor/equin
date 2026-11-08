import { expect, test } from "bun:test";
import { migrationSubject } from "./migration-subject";

test("a migration is named by its slug and phase, not its generated prefix", () => {
  expect(
    migrationSubject(
      "20261108_172209_b59ce2dc__page_links_first_edge.sql",
      "expand",
    ),
  ).toBe("migration page_links_first_edge (expand)");
  // The same change regenerated: one subject.
  expect(
    migrationSubject(
      "20261108_171645_4dc30710__page_links_first_edge.sql",
      "expand",
    ),
  ).toBe(
    migrationSubject(
      "20261108_172209_b59ce2dc__page_links_first_edge.sql",
      "expand",
    ),
  );
});

test("a name outside the generated grammar is kept whole", () => {
  expect(migrationSubject("hand.sql", "whole")).toBe("migration hand (whole)");
});
