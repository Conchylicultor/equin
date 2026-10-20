import { describe, expect, test } from "bun:test";
import {
  BASELINE_MODELS,
  ConversationModelSchema,
  type ConversationModel,
  type ModelCatalog,
  type ModelTier,
} from "@plugins/conversations/plugins/model-provider/core";
import type { CliMenu } from "./menu";
import { applyMenu } from "./transitions";

const id = (raw: string) => ConversationModelSchema.parse(raw);
const now = new Date("2026-10-02T05:00:00.000Z");
const run = { now, cliVersion: "2.2.0" };

/** The menu the baseline describes: every family at its current version, every version offered. */
function baselineMenu(
  edit: {
    current?: Partial<Record<ModelTier, ConversationModel>>;
    drop?: string[];
    add?: string[];
  } = {},
): CliMenu {
  const current = { ...BASELINE_MODELS.current, ...edit.current };
  const offered = [
    ...BASELINE_MODELS.versions.map((v) => v.id),
    ...(edit.add ?? []).map(id),
  ].filter((v) => !(edit.drop ?? []).includes(v));
  return { current, offered, problems: [] };
}

const version = (c: ModelCatalog, raw: string) =>
  c.versions.find((v) => v.id === raw);

describe("applyMenu", () => {
  test("the menu the catalog already describes changes nothing but the run stamp", () => {
    const { catalog, changes } = applyMenu(
      BASELINE_MODELS,
      baselineMenu(),
      run,
    );
    expect(changes).toEqual({
      moves: [],
      added: [],
      retired: [],
      unretired: [],
    });
    expect(catalog.versions).toEqual(BASELINE_MODELS.versions);
    expect(catalog.current).toEqual(BASELINE_MODELS.current);
    expect(catalog.probedAt).toBe(now.toISOString());
    expect(catalog.cliVersion).toBe("2.2.0");
  });

  test("a new version is appended and its family's current moves to it", () => {
    const { catalog, changes } = applyMenu(
      BASELINE_MODELS,
      baselineMenu({ current: { sonnet: id("sonnet-9") }, add: ["sonnet-9"] }),
      run,
    );
    expect(changes.moves).toEqual([
      { family: "sonnet", from: id("sonnet-5-5"), to: id("sonnet-9") },
    ]);
    expect(changes.added).toEqual([id("sonnet-9")]);
    expect(catalog.current.sonnet).toBe(id("sonnet-9"));
    expect(catalog.versions.at(-1)).toEqual({
      id: id("sonnet-9"),
      firstSeenAt: now.toISOString(),
      source: "cli",
    });
    // The version it replaced stays offered, so it stays live.
    expect(version(catalog, "sonnet-5-5")?.retiredAt).toBeUndefined();
  });

  test("a version gone from the menu is retired; one that comes back is un-retired", () => {
    const gone = applyMenu(
      BASELINE_MODELS,
      baselineMenu({ drop: ["opus-4-6"] }),
      run,
    );
    expect(gone.changes.retired).toEqual([id("opus-4-6")]);
    expect(version(gone.catalog, "opus-4-6")).toMatchObject({
      retiredAt: now.toISOString(),
      retiredReason: "no longer offered by Claude Code 2.2.0",
    });

    const back = applyMenu(gone.catalog, baselineMenu(), {
      now: new Date("2026-10-03T05:00:00.000Z"),
      cliVersion: "2.2.1",
    });
    expect(back.changes.unretired).toEqual([id("opus-4-6")]);
    expect(version(back.catalog, "opus-4-6")).toEqual(
      version(BASELINE_MODELS, "opus-4-6"),
    );
  });

  test("a family the menu leaves out keeps its current version, which is never retired", () => {
    const menu = baselineMenu({ drop: ["haiku-4-5"] });
    delete menu.current.haiku;
    const { catalog, changes } = applyMenu(BASELINE_MODELS, menu, run);
    expect(catalog.current.haiku).toBe(id("haiku-4-5"));
    expect(changes.moves).toEqual([]);
    expect(changes.retired).toEqual([]);
  });
});
