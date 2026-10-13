import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import { enumTextField } from "@plugins/fields/plugins/text/plugins/config/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { liveText } from "@plugins/network/plugins/live/plugins/filter/core";
import { ResourceContractError } from "@plugins/packages/plugins/resource-protocol/core";
import { exposedColumns } from "./exposed-columns";
import { liveCollection } from "./live-collection";
import { LIVE_COLUMNS_KEY } from "./live-columns";

// Exposed columns: an extension's exposed fields as a column set, read by every
// collection whose `exposes` reaches the exposure's entity.

const tasks = entityRef("tasks");
const conversations = entityRef("conversations");

const trackShape = defineExtensionShape({
  key: "taskId",
  fields: { track: enumTextField(["sidequest"] as const) },
  exposes: {
    parent: tasks,
    name: "track",
    fields: {
      track: {
        label: "Track",
        absent: "main",
        options: {
          main: { label: "Main" },
          sidequest: { label: "Sidequest", variant: "info" },
        },
      },
    },
  },
});
const usageShape = defineExtensionShape({
  key: "conversationId",
  fields: { cost: intField(), lastAt: dateField(), open: boolField() },
  exposes: {
    parent: conversations,
    name: "usage",
    fields: {
      cost: { label: "Cost", absent: 0 },
      lastAt: { label: "Last", absent: null },
      open: { label: "Open", absent: false },
    },
  },
});
const track = exposedColumns(trackShape.exposure);
const usage = exposedColumns(usageShape.exposure);

const Row = z.object({ id: z.string(), title: z.string() });

describe("exposedColumns", () => {
  it("is named by the slice, owned by the parent entity, one object per exposure", () => {
    expect(track.name).toBe("tasks_ext_track");
    expect(track.owner).toEqual({ kind: "exposed", entity: "tasks" });
    expect(track.wireName("track")).toBe("tasks_ext_track.track");
    expect(exposedColumns(trackShape.exposure)).toBe(track);
  });

  it("derives each field's filter domain from its type", () => {
    expect(track.wireFilterable).toEqual({
      "tasks_ext_track.track": { domain: "text" },
    });
    expect(usage.wireFilterable).toEqual({
      "conversations_ext_usage.cost": { domain: "number" },
      "conversations_ext_usage.lastAt": { domain: "instant" },
      "conversations_ext_usage.open": { domain: "boolean" },
    });
    expect(usage.wireSortable).toEqual([
      "conversations_ext_usage.cost",
      "conversations_ext_usage.lastAt",
      "conversations_ext_usage.open",
    ]);
    expect(track.column("track")).toMatchObject({
      owner: { kind: "exposed", entity: "tasks" },
      name: "tasks_ext_track.track",
      domain: "text",
      sortable: true,
    });
  });

  it("throws on a field whose type has no filter domain", () => {
    const shape = defineExtensionShape({
      key: "taskId",
      fields: {
        blob: jsonField({
          schema: z.object({ a: z.number() }),
          default: { a: 0 },
        }),
      },
      exposes: {
        parent: tasks,
        name: "blob",
        fields: { blob: { label: "Blob", absent: null } },
      },
    });
    expect(() => exposedColumns(shape.exposure)).toThrow(
      /field "blob" is of type "json", which has no filter domain/,
    );
  });

  it("reads its slice off a row, and throws on a row that carries none", () => {
    const row = { [LIVE_COLUMNS_KEY]: { tasks_ext_track: { track: "main" } } };
    expect(track.read(row)).toEqual({ track: "main" });
    expect(track.read(row)).toBe(track.read(row));
    expect(() => track.read({ [LIVE_COLUMNS_KEY]: {} })).toThrow(
      /carries no "tasks_ext_track" slice/,
    );
  });
});

describe("liveCollection — exposes", () => {
  let n = 0;
  const window = () =>
    liveCollection(`live-test.exposes-${n++}`, {
      row: Row,
      id: "id",
      filterable: { title: liveText() },
      sortable: ["title"],
      default: { orderBy: [["title", "asc"]], limit: 10 },
      maxLimit: 50,
      count: true,
      exposes: { base: conversations, task: tasks },
    });

  it("its rows carry `$columns`; its own row keys stay the author's", () => {
    const c = window();
    expect(c.exposes).toEqual({ base: conversations, task: tasks });
    expect(c.rowKeys).toEqual(["id", "title"]);
    expect(
      c.row.parse({ id: "a", title: "t", [LIVE_COLUMNS_KEY]: {} }),
    ).toEqual({ id: "a", title: "t", [LIVE_COLUMNS_KEY]: {} });
  });

  it("an `all` set reaches exposures too", () => {
    const c = liveCollection(`live-test.exposes-all-${n++}`, {
      row: Row,
      id: "id",
      all: { orderBy: [["title", "asc"]], unbounded: { reason: "test" } },
      exposes: { task: tasks },
    });
    expect(c.exposes).toEqual({ task: tasks });
    expect(c.rowKeys).toEqual(["id", "title"]);
    expect(
      c.all.schema.safeParse([{ id: "a", title: "t", [LIVE_COLUMNS_KEY]: {} }])
        .success,
    ).toBe(true);
  });

  it("refuses an empty one, a non-identifier relation, one entity twice, and a lookup / union carrier", () => {
    const base = {
      row: Row,
      id: "id" as const,
      filterable: {},
      sortable: ["title"] as const,
      default: { orderBy: [["title", "asc"]] as const, limit: 10 },
      maxLimit: 50,
    };
    expect(() =>
      liveCollection(`live-test.exposes-bad-${n++}`, { ...base, exposes: {} }),
    ).toThrow(/`exposes` is empty/);
    expect(() =>
      liveCollection(`live-test.exposes-bad-${n++}`, {
        ...base,
        exposes: { "a.b": tasks },
      }),
    ).toThrow(/names relation "a.b", which is not an identifier/);
    expect(() =>
      liveCollection(`live-test.exposes-bad-${n++}`, {
        ...base,
        exposes: { base: tasks, task: tasks },
      }),
    ).toThrow(/reaches entity "tasks" through both "base" and "task"/);
    expect(() =>
      liveCollection(`live-test.exposes-bad-${n++}`, {
        row: Row,
        id: "id",
        exposes: { task: tasks },
      } as never),
    ).toThrow(/exposes without `default`/);
  });

  it("a query, a grouping and a count name the exposed columns it reaches", () => {
    const c = window();
    const columns = [track, usage];
    const params = c.window.window.encode({
      where: { "tasks_ext_track.track": "sidequest" } as never,
      orderBy: [["conversations_ext_usage.cost", "desc"]] as never,
      columns,
    });
    expect(c.window.window.decode(params, columns).where).toEqual({
      column: "tasks_ext_track.track",
      op: "eq",
      operand: "sidequest",
    });
    // The descriptor's own gate knows no exposed column (the server's does).
    expect(() => c.window.window.decode(params)).toThrow(ResourceContractError);

    const groups = c.groups.groups.encode({
      groupBy: "tasks_ext_track.track" as never,
      where: { "conversations_ext_usage.open": true } as never,
      columns,
    });
    expect(groups.groupBy).toBe("tasks_ext_track.track");
    expect(c.groups.groups.decode(groups, columns).groupBy as string).toBe(
      "tasks_ext_track.track",
    );
    expect(() => c.groups.groups.decode(groups)).toThrow(ResourceContractError);
    // An instant column is filterable but not groupable.
    expect(() =>
      c.groups.groups.encode({
        groupBy: "conversations_ext_usage.lastAt" as never,
        columns,
      }),
    ).toThrow(/is a instant column/);

    const count = c.count.count.encode({
      where: { "tasks_ext_track.track": "main" },
      columns,
    });
    expect(c.count.count.decode(count, columns).where).toEqual({
      column: "tasks_ext_track.track",
      op: "eq",
      operand: "main",
    });
    expect(() => c.count.count.decode(count)).toThrow(ResourceContractError);
  });

  it("refuses exposed columns of an entity its `exposes` does not reach", () => {
    const c = liveCollection(`live-test.exposes-narrow-${n++}`, {
      row: Row,
      id: "id",
      filterable: {},
      sortable: ["title"],
      default: { orderBy: [["title", "asc"]], limit: 10 },
      maxLimit: 50,
      exposes: { base: conversations },
    });
    expect(() =>
      c.window.window.encode({
        where: { "tasks_ext_track.track": "main" } as never,
        columns: [track],
      }),
    ).toThrow(
      /entity "tasks", which the collection's `exposes` does not reach/,
    );
  });
});
