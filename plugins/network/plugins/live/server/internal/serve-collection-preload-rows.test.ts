/**
 * `serveCollection(c, { preloadRows: { idsOf } })`: the `:rows` sibling is an
 * enumerated preload at ONE tuple — the id set of `idsOf`'s boot value,
 * encoded by the point codec the reader subscribes through, so a reader
 * holding that set in any order asks for exactly the preloaded tuple. With
 * `field`, the ids are one field of `idsOf`'s rows (deduped).
 *
 * Run: `./equin test plugins/network/plugins/live`.
 */

import { describe, expect, test } from "bun:test";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { defineEntity } from "@plugins/infra/plugins/entities/server";
import { recordingQueryDb } from "@plugins/network/plugins/live/plugins/query-resource/server/testing";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { serveCollection } from "./serve-collection";

const peopleRef = entityRef("pr_people", {
  id: textField({ label: "Id" }),
  name: textField({ label: "Name" }),
});
const people = defineEntity(peopleRef, { primaryKey: "id" });
const scoresRef = entityRef("pr_scores", {
  personId: textField({ label: "Person" }),
  score: intField({ label: "Score" }),
});
const scores = defineEntity(scoresRef, { primaryKey: "personId" });
const teamsRef = entityRef("pr_teams", {
  id: textField({ label: "Id" }),
  captainId: textField({ label: "Captain" }),
});
const teams = defineEntity(teamsRef, { primaryKey: "id" });

let seq = 0;
const peopleCollection = (preload?: "boot") =>
  liveCollection(`test.live.preload-rows-people-${seq++}`, {
    from: peopleRef,
    baseExposures: false,
    carry: { pick: ["id", "name"] },
    id: "id",
    all: {
      orderBy: [["name", "asc"]],
      unbounded: { reason: "a test set", budget: 1000 },
    },
    ...(preload === undefined ? {} : { preload }),
  });
const scoresCollection = () =>
  liveCollection(`test.live.preload-rows-scores-${seq++}`, {
    from: scoresRef,
    baseExposures: false,
    carry: { pick: ["personId", "score"] },
    id: "personId",
    sortable: ["score"],
    default: { orderBy: [["score", "asc"]], limit: 10 },
    maxLimit: 20,
  });

const teamsCollection = () =>
  liveCollection(`test.live.preload-rows-teams-${seq++}`, {
    from: teamsRef,
    baseExposures: false,
    carry: { pick: ["id", "captainId"] },
    id: "id",
    all: {
      orderBy: [["id", "asc"]],
      unbounded: { reason: "a test set", budget: 1000 },
    },
    preload: "boot",
  });

describe("preloadRows", () => {
  test("the :rows Declare preloads the point tuple of the source's id set", async () => {
    const source = peopleCollection("boot");
    serveCollection(source, {
      from: people,
      db: recordingQueryDb(() => [
        { id: "p2", name: "Ann" },
        { id: "p1", name: "Bob" },
      ]).db,
    });
    const target = scoresCollection();
    const served = serveCollection(target, {
      from: scores,
      preloadRows: { idsOf: source },
      db: recordingQueryDb(() => [
        { personId: "p1", score: 3 },
        { personId: "p2", score: 5 },
      ]).db,
    });

    const rows = served.declare.find((d) => d.key === `${target.key}:rows`)!;
    expect(rows.preload).toBe("boot");
    // Only `:rows` is preloaded: the window keeps its own (absent) flag.
    expect(
      served.declare.find((d) => d.key === target.key)!.preload,
    ).toBeUndefined();

    // A contribution's payload fields read back as `unknown`.
    const load = rows.preloadTuples as (() => Promise<unknown[]>) | undefined;
    expect(load).toBeDefined();
    const tuples = (await load!()) as {
      params: unknown;
      ok: boolean;
      value?: unknown;
    }[];
    // The reader's tuple: its id set through the same point codec, whatever
    // order it holds the ids in.
    expect(tuples).toEqual([
      {
        params: target.rows.point.encode(["p2", "p1"]),
        ok: true,
        value: [
          { personId: "p1", score: 3 },
          { personId: "p2", score: 5 },
        ],
      },
    ]);
    expect(tuples[0]!.params).toEqual({ ids: "p1,p2" });
  });

  test("`field`: the tuple is the distinct values of one field of the source's rows", async () => {
    const source = teamsCollection();
    serveCollection(source, {
      from: teams,
      db: recordingQueryDb(() => [
        { id: "t1", captainId: "p2" },
        { id: "t2", captainId: "p1" },
        { id: "t3", captainId: "p2" },
      ]).db,
    });
    const target = scoresCollection();
    const served = serveCollection(target, {
      from: scores,
      preloadRows: { idsOf: source, field: "captainId" },
      db: recordingQueryDb(() => [
        { personId: "p1", score: 3 },
        { personId: "p2", score: 5 },
      ]).db,
    });
    const rows = served.declare.find((d) => d.key === `${target.key}:rows`)!;
    // A contribution's payload fields read back as `unknown`.
    const load = rows.preloadTuples as (() => Promise<unknown[]>) | undefined;
    expect(load).toBeDefined();
    const tuples = (await load!()) as { params: unknown; ok: boolean }[];
    expect(tuples.map((t) => t.params)).toEqual([{ ids: "p1,p2" }]);
    expect(tuples[0]!.ok).toBe(true);
  });

  test("`field` naming no field of the source: a serve-time throw", () => {
    const source = teamsCollection();
    serveCollection(source, { from: teams, db: recordingQueryDb().db });
    const target = scoresCollection();
    expect(() =>
      serveCollection(target, {
        from: scores,
        preloadRows: { idsOf: source, field: "coachId" },
        db: recordingQueryDb().db,
      }),
    ).toThrow(/`preloadRows.field` "coachId" is not a field of/);
  });

  test("a source that is not preloaded names no boot tuple: a serve-time throw", () => {
    const source = peopleCollection();
    serveCollection(source, { from: people, db: recordingQueryDb().db });
    const target = scoresCollection();
    expect(() =>
      serveCollection(target, {
        from: scores,
        preloadRows: { idsOf: source },
        db: recordingQueryDb().db,
      }),
    ).toThrow(/`preloadRows.idsOf` ".*" is not preloaded/);
  });
});
