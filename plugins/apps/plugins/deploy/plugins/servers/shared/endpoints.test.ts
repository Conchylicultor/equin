import { describe, expect, test } from "bun:test";
import { readLiveEffect } from "@plugins/network/plugins/live/core";
import { deleteServer, updateServer } from "./endpoints";

function target(effect: Parameters<typeof readLiveEffect>[0], body: unknown) {
  const [t] = readLiveEffect(effect).resolve({
    params: { id: "srv1" },
    body,
  }).targets;
  if (t === undefined || t.kind !== "row") throw new Error("row target");
  return t;
}

describe("server effects", () => {
  test("updateServer sets only the fields sent; a blank console URL is stored null", () => {
    expect(target(updateServer.effect, { sshUser: "root" }).set).toEqual({
      sshUser: "root",
    });
    expect(target(updateServer.effect, { consoleUrl: "" }).set).toEqual({
      consoleUrl: null,
    });
  });

  test("deleteServer removes the row", () => {
    const t = target(deleteServer.effect, undefined);
    expect(t.subject).toBe("deploy_servers");
    expect(t.apply({ id: "srv1" })).toBeUndefined();
  });
});
