import { describe, expect, test } from "bun:test";
import { readLiveEffect } from "@plugins/network/plugins/live/core";
import { resetTrackView, upsertTrackView } from "./endpoints";

type Rows = readonly Record<string, unknown>[];

function value(effect: unknown, body: unknown): (rows: Rows) => Rows {
  const [t] = readLiveEffect(effect as never).resolve({
    params: { songId: "s1" },
    body,
  }).targets;
  if (t === undefined || t.kind !== "value") throw new Error("value target");
  expect(t.params).toEqual({ songId: "s1" });
  return (rows) => t.apply(rows) as Rows;
}

const existing = {
  songId: "s1",
  trackId: "a",
  color: "red",
  instrument: null,
  muted: false,
  hidden: false,
  volume: 1,
};

describe("upsertTrackView effect", () => {
  test("patches only the provided fields of existing rows", () => {
    const next = value(upsertTrackView.effect, {
      trackIds: ["a"],
      volume: 0.5,
    })([existing]);
    expect(next).toEqual([{ ...existing, volume: 0.5 }]);
  });

  test("a track with no row enters with the column defaults", () => {
    const next = value(upsertTrackView.effect, {
      trackIds: ["a", "b"],
      muted: true,
      hidden: true,
    })([existing]);
    expect(next[0]).toMatchObject({ trackId: "a", muted: true, color: "red" });
    expect(next[1]).toEqual({
      songId: "s1",
      trackId: "b",
      color: null,
      instrument: null,
      muted: true,
      hidden: true,
      volume: 1,
    });
  });

  test("an explicit null clears a color", () => {
    const next = value(upsertTrackView.effect, {
      trackIds: ["a"],
      color: null,
    })([existing]);
    expect(next[0]?.color).toBeNull();
  });
});

describe("resetTrackView effect", () => {
  test("empties the song's value", () => {
    expect(value(resetTrackView.effect, undefined)([existing])).toEqual([]);
  });
});
