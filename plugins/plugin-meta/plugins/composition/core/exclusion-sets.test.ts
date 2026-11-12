/**
 * The exclusion-set rules `composition-closure` enforces, on the committed seeds
 * and on registries edited to break one rule each.
 */
import { test, expect } from "bun:test";
import { flattenManifest } from "@plugins/plugin-meta/plugins/closure/core";
import {
  ALL_EXCLUSIONS_ID,
  BASE_EXCLUSIONS_ID,
  MAIN_COMPOSITION_ID,
} from "@plugins/infra/plugins/namespace/core";
import { compositionsConfig } from "./config";
import { checkExclusionSets } from "./exclusion-sets";
import {
  manifestItemToManifest,
  type CompositionManifestItem,
} from "./manifest-map";

const seeds = compositionsConfig.defaults
  .manifests as CompositionManifestItem[];

const row = (name: string): CompositionManifestItem => {
  const m = seeds.find((x) => x.name === name);
  if (!m) throw new Error(`seed composition "${name}" not found`);
  return m;
};

/** The seeds with `name`'s row replaced by `patch` applied to it. */
const edited = (
  name: string,
  patch: Partial<CompositionManifestItem>,
): CompositionManifestItem[] =>
  seeds.map((s) => (s.name === name ? { ...s, ...patch } : s));

const messageOf = (items: CompositionManifestItem[]): string => {
  const verdict = checkExclusionSets(items);
  if (verdict.kind === "ok") throw new Error("expected a refusal");
  return verdict.message;
};

test("the committed seeds pass", () => {
  expect(checkExclusionSets(seeds)).toEqual({ kind: "ok" });
});

test("the two reserved sets are exclusion sets, and the default extends the base", () => {
  expect(row(BASE_EXCLUSIONS_ID).category).toBe("exclusions");
  expect(row(ALL_EXCLUSIONS_ID).category).toBe("exclusions");
  expect(row(ALL_EXCLUSIONS_ID).extends).toEqual([BASE_EXCLUSIONS_ID]);
});

test("a row naming no set inherits all-exclusions; promo-film names base-exclusions", () => {
  const registry = seeds.map(manifestItemToManifest);
  const circle = "!apps.website.promo-film.circle";
  expect(row(ALL_EXCLUSIONS_ID).entryPoints).toContain(circle);

  const main = manifestItemToManifest(row(MAIN_COMPOSITION_ID));
  expect(main.exclusions).toBe(ALL_EXCLUSIONS_ID);
  const mainFlat = flattenManifest(main, registry).entryPoints;
  expect(mainFlat).toContain(circle);
  expect(mainFlat).toContain("!review.plugin-changes.**");

  const film = manifestItemToManifest(row("promo-film"));
  expect(film.exclusions).toBe(BASE_EXCLUSIONS_ID);
  const filmFlat = flattenManifest(film, registry).entryPoints;
  expect(filmFlat).not.toContain(circle);
  expect(filmFlat).toContain("!review.plugin-changes.**");
});

test("a set that does not reach base-exclusions is refused", () => {
  expect(messageOf(edited(ALL_EXCLUSIONS_ID, { extends: [] }))).toContain(
    `does not include "${BASE_EXCLUSIONS_ID}"`,
  );
});

test("a row naming a non-exclusions row as its set is refused", () => {
  expect(
    messageOf(edited("promo-film", { exclusions: "served-baseline" })),
  ).toContain("is not an exclusion set");
  expect(messageOf(edited("promo-film", { exclusions: "nope" }))).toContain(
    "is no composition",
  );
});

test("a set may only exclude, extend sets, and is never served", () => {
  expect(
    messageOf(
      edited(ALL_EXCLUSIONS_ID, {
        entryPoints: ["apps.website.promo-film.circle"],
      }),
    ),
  ).toContain("positive entry point");
  expect(
    messageOf(
      edited(ALL_EXCLUSIONS_ID, {
        extends: [BASE_EXCLUSIONS_ID, "served-baseline"],
      }),
    ),
  ).toContain("not an exclusion set");
  expect(messageOf(edited(BASE_EXCLUSIONS_ID, { serve: "manual" }))).toContain(
    "serve",
  );
});

test("a reserved set must exist, as a set", () => {
  expect(messageOf(seeds.filter((s) => s.id !== ALL_EXCLUSIONS_ID))).toContain(
    `exactly one composition with id "${ALL_EXCLUSIONS_ID}"`,
  );
  expect(messageOf(edited(BASE_EXCLUSIONS_ID, { category: "pack" }))).toContain(
    'not "exclusions"',
  );
});

test("a composition chooses its set through `exclusions`, never `extends`", () => {
  expect(
    messageOf(edited("promo-film", { extends: [BASE_EXCLUSIONS_ID] })),
  ).toContain("extends the exclusion set");
});
