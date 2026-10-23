import { describe, expect, test } from "bun:test";
import { defineApp } from "@plugins/primitives/plugins/pane/core";
import type { HintSeen } from "../../core";
import { defineHintAnchor } from "../../core/internal/anchors";
import { defineHint, defineTour } from "../../core/internal/declarations";
import { joinCatalog } from "./catalog";

const anchor = defineHintAnchor("c.a");
const app = defineApp({
  id: "home",
  name: "Home",
  basePath: "/home",
  iconKey: "home",
});

describe("joinCatalog", () => {
  test("joins every declared hint and tour with its seen row", () => {
    const seenAt = new Date("2026-10-22T10:00:00Z");
    const tip = defineHint({ id: "tip", anchor, title: "", body: "" });
    const fresh = defineHint({ id: "fresh", anchor, title: "", body: "" });
    const tour = defineTour({
      id: "tour",
      app,
      initialData: {},
      steps: [{ id: "s", anchor, title: "", body: "" }],
    });
    const seen = new Map<string, HintSeen>([
      ["tip", { hintId: "tip", outcome: "acted", seenAt }],
      ["tour", { hintId: "tour", outcome: null, seenAt }],
      ["orphan", { hintId: "orphan", outcome: "dismissed", seenAt }],
    ]);
    const entries = joinCatalog([tip, fresh], [tour], seen);
    expect(
      entries.map((e) => [e.kind, e.status, "outcome" in e ? e.outcome : "-"]),
    ).toEqual([
      ["hint", "seen", "acted"],
      ["hint", "not-encountered", "-"],
      ["tour", "seen", null],
    ]);
  });
});
