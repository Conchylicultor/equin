import { describe, expect, it } from "bun:test";
import type { ComponentType } from "react";
import type { SealContributions } from "@plugins/framework/plugins/web-sdk/core";
import type { ViewSourceEntry, ViewTypeMeta } from "../../core";
import { buildInstanceFromRow } from "./resolve-instances";

const Icon: ComponentType<{ className?: string }> = () => null;

const table = { type: "table", title: "Table", icon: Icon };
const gallery = { type: "gallery", title: "Gallery", icon: Icon };
const contributions = [
  table,
  gallery,
] as unknown as SealContributions<ViewTypeMeta>[];

/** The implicit sole source (the single-source case). */
const implicitEntry: ViewSourceEntry = {
  contributions,
};

const queueEntry: ViewSourceEntry = {
  id: "queue",
  title: "Queue",
  contributions,
};

describe("buildInstanceFromRow — source-entry resolution", () => {
  it("a source-less row resolves through the implicit (id: undefined) entry", () => {
    const resolved = buildInstanceFromRow(
      { id: "a", name: "A", view: { type: "table" } },
      [implicitEntry],
    );
    expect(resolved).not.toBeNull();
    expect(resolved!.instance.type).toBe("table");
    // The instance carries no `source` key at all (implicit sole source).
    expect("source" in resolved!.instance).toBe(false);
  });

  it("a sourceful row resolves through its matching entry and carries source", () => {
    const resolved = buildInstanceFromRow(
      { id: "q", name: "Q", view: { type: "table" }, source: "queue" },
      [implicitEntry, queueEntry],
    );
    expect(resolved).not.toBeNull();
    expect(resolved!.instance.source).toBe("queue");
  });

  it("fail-softs an unknown source BEFORE the type lookup", () => {
    // The type IS registered — only the source is unknown, so the null must
    // come from the entry lookup, not the type lookup.
    const resolved = buildInstanceFromRow(
      { id: "x", name: "X", view: { type: "table" }, source: "gone" },
      [implicitEntry, queueEntry],
    );
    expect(resolved).toBeNull();
  });

  it("a sourceful row never falls back to the implicit entry (and vice versa)", () => {
    // Only the implicit entry exists → a sourceful row is an unknown source.
    expect(
      buildInstanceFromRow(
        { id: "q", name: "Q", view: { type: "table" }, source: "queue" },
        [implicitEntry],
      ),
    ).toBeNull();
    // Only named entries exist → a source-less row is an unknown source.
    expect(
      buildInstanceFromRow({ id: "a", name: "A", view: { type: "table" } }, [
        queueEntry,
      ]),
    ).toBeNull();
  });

  it("fail-softs an orphan view-type within a matched entry", () => {
    expect(
      buildInstanceFromRow(
        { id: "x", name: "X", view: { type: "kanban" }, source: "queue" },
        [queueEntry],
      ),
    ).toBeNull();
  });

  it("does NOT apply the entry's views whitelist to authored rows", () => {
    // The whitelist gates the add menu only — an authored row of a
    // non-whitelisted type still renders (single-source semantics preserved).
    const whitelisted: ViewSourceEntry = { ...queueEntry, views: ["gallery"] };
    const resolved = buildInstanceFromRow(
      { id: "q", name: "Q", view: { type: "table" }, source: "queue" },
      [whitelisted],
    );
    expect(resolved).not.toBeNull();
  });

  it("merges the entry's viewOptions[type] UNDER the row's view blob", () => {
    const withOptions: ViewSourceEntry = {
      ...queueEntry,
      viewOptions: { table: { codeOnly: "kept", overridden: "code" } },
    };
    const resolved = buildInstanceFromRow(
      {
        id: "q",
        name: "Q",
        view: { type: "table", overridden: "config" },
        source: "queue",
      },
      [withOptions],
    );
    expect(resolved!.instance.options).toEqual({
      codeOnly: "kept",
      overridden: "config",
      type: "table",
    });
  });
});
