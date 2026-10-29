import { describe, expect, test } from "bun:test";
import { readLiveEffect } from "@plugins/network/plugins/live/core";
import {
  clearMapsBrowserConfig,
  clearMapsMapId,
  setMapsBrowserConfig,
} from "./browser-config";

function apply(def: { effect: unknown }, value: unknown, body?: unknown) {
  const [t] = readLiveEffect(def.effect as never).resolve({
    params: {},
    body,
  }).targets;
  if (t?.kind !== "value") throw new Error("expected a value target");
  return t.apply(value);
}

describe("Maps browser config effects", () => {
  test("setting a key keeps a stored Map ID", () => {
    const body = { browserKey: "AIza" + "x".repeat(35) };
    expect(
      apply(
        setMapsBrowserConfig,
        { kind: "set", browserKey: "old", mapId: "m1" },
        body,
      ),
    ).toEqual({ kind: "set", browserKey: body.browserKey, mapId: "m1" });
    expect(apply(setMapsBrowserConfig, { kind: "unset" }, body)).toEqual({
      kind: "set",
      browserKey: body.browserKey,
      mapId: null,
    });
  });
  test("clearing the Map ID keeps the key; clearing the config unsets it", () => {
    expect(
      apply(clearMapsMapId, { kind: "set", browserKey: "k", mapId: "m" }),
    ).toEqual({ kind: "set", browserKey: "k", mapId: null });
    expect(apply(clearMapsMapId, { kind: "unset" })).toEqual({ kind: "unset" });
    expect(
      apply(clearMapsBrowserConfig, {
        kind: "set",
        browserKey: "k",
        mapId: "m",
      }),
    ).toEqual({ kind: "unset" });
  });
});
