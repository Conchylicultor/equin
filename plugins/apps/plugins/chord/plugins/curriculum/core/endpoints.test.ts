import { describe, expect, test } from "bun:test";
import { readLiveEffect } from "@plugins/network/plugins/live/core";
import { setBlanksEndpoint, setChordsEndpoint } from "./endpoints";
import { withBlanks, withChordChanges } from "./change";
import type { Selection } from "./selection";

function reduce(effect: unknown, body: unknown, sel: Selection): Selection {
  const [t] = readLiveEffect(effect as never).resolve({
    params: {},
    body,
  }).targets;
  if (t === undefined || t.kind !== "value") throw new Error("value target");
  return t.apply(sel) as Selection;
}

const empty = { chords: [], blanks: "all", extras: 0 } as unknown as Selection;

describe("curriculum effects", () => {
  test("setChords folds the server's own reducer over the held selection", () => {
    const changes = [{ token: "I", state: "practise" }] as never;
    expect(reduce(setChordsEndpoint.effect, { changes }, empty)).toEqual(
      withChordChanges(empty, changes),
    );
  });

  test("setBlanks sets the blanks", () => {
    expect(reduce(setBlanksEndpoint.effect, { blanks: "half" }, empty)).toEqual(
      withBlanks(empty, "half" as never),
    );
  });
});
