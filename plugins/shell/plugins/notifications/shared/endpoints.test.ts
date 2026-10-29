import { describe, expect, test } from "bun:test";
import { matchesFilter } from "@plugins/network/plugins/live/plugins/filter/core";
import { readLiveEffect } from "@plugins/network/plugins/live/core";
import { dismissAllNotifications, markAllNotificationsRead } from "./endpoints";

function whereTarget(def: { effect: unknown }) {
  const [t] = readLiveEffect(def.effect as never).resolve({
    params: {},
    body: undefined,
  }).targets;
  if (t?.kind !== "where") throw new Error("expected a where target");
  return t;
}

describe("bulk notification effects", () => {
  test("dismiss-all patches every held row to dismissed", () => {
    const t = whereTarget(dismissAllNotifications);
    expect(t.apply({ id: "n1", dismissed: false })).toMatchObject({
      id: "n1",
      dismissed: true,
    });
  });

  test("mark-all-read patches the undismissed unread rows to read", () => {
    const t = whereTarget(markAllNotificationsRead);
    expect(t.apply({ id: "n1", read: false, dismissed: false })).toMatchObject({
      read: true,
    });
    const matches = (row: Record<string, unknown>) =>
      matchesFilter(row, t.filter, t.filterable);
    expect(matches({ read: false, dismissed: false })).toBe(true);
    expect(matches({ read: true, dismissed: false })).toBe(false);
    expect(matches({ read: false, dismissed: true })).toBe(false);
  });
});
