import { describe, expect, test } from "bun:test";
import { readLiveEffect } from "@plugins/network/plugins/live/core";
import { deletePlace, updatePlace } from "./endpoints";

type Row = Readonly<Record<string, unknown>>;

function predict(
  id: string,
  body: Record<string, unknown>,
  row: Row,
): Row | undefined {
  const [target] = readLiveEffect(updatePlace.effect).resolve({
    params: { id },
    body,
  }).targets;
  if (target === undefined || target.kind !== "rows") {
    throw new Error("expected a rows target");
  }
  return target.apply([row])[0];
}

const google: Row = {
  id: "p1",
  googlePlaceId: "g1",
  name: "Rue Sainte-Anne",
  title: null,
  note: "",
  tags: ["a", "b"],
  autoTags: ["a", "b"],
  location: { lat: 1, lng: 2 },
};
const custom: Row = { ...google, googlePlaceId: null, name: "My pin" };

describe("updatePlace effect", () => {
  test("a removed tag leaves autoTags too", () => {
    expect(predict("p1", { tags: ["a"] }, google)).toMatchObject({
      tags: ["a"],
      autoTags: ["a"],
    });
  });

  test("a Google place's title is over Google's name; Google's own name or blank clears it", () => {
    expect(predict("p1", { title: " Japantown " }, google)?.title).toBe(
      "Japantown",
    );
    expect(
      predict("p1", { title: "Rue Sainte-Anne" }, google)?.title,
    ).toBeNull();
    expect(predict("p1", { title: "  " }, google)?.title).toBeNull();
    expect(predict("p1", { title: "x" }, google)?.name).toBe("Rue Sainte-Anne");
  });

  test("a custom place's rename is its name; blank is refused, so the row stays", () => {
    expect(predict("p1", { title: "Home" }, custom)?.name).toBe("Home");
    expect(predict("p1", { title: " " }, custom)?.name).toBe("My pin");
  });

  test("only a custom place's pin moves", () => {
    const at = { lat: 5, lng: 6 };
    expect(predict("p1", { location: at }, custom)?.location).toEqual(at);
    expect(predict("p1", { location: at }, google)?.location).toEqual({
      lat: 1,
      lng: 2,
    });
  });
});

describe("deletePlace effect", () => {
  test("removes the place row", () => {
    const [t] = readLiveEffect(deletePlace.effect).resolve({
      params: { id: "p1" },
      body: undefined,
    }).targets;
    if (t === undefined || t.kind !== "row") throw new Error("row target");
    expect(t.subject).toBe("places");
    expect(t.id).toBe("p1");
    expect(t.apply(google)).toBeUndefined();
  });
});
