import { describe, expect, it } from "bun:test";
import type { FieldKind } from "@plugins/fields/core";
import type {
  FieldDef,
  PlacementSpec,
  PropertyEntry,
  ViewSlots,
} from "../../core";
import { dropOrderOf, fieldAlign, resolvePlacement } from "./placement";

type Row = Record<string, unknown>;
type F = FieldDef<Row> & { kind: FieldKind };

const f = (
  id: string,
  kind: FieldKind,
  extra: Partial<FieldDef<Row>> = {},
): F => ({ id, label: id, kind, ...extra }) as F;

const LIST: ViewSlots = {
  lead: { capacity: 1, form: "glyph" },
  title: { capacity: 1 },
  afterTitle: {},
  line2: {},
  trail: {},
  edge: { capacity: 1 },
};

function place(
  fields: F[],
  spec: PlacementSpec = {},
  opts: { slots?: ViewSlots; properties?: PropertyEntry[] } = {},
) {
  const p = resolvePlacement<Row>({
    fields,
    kindOf: (field) => (field as F).kind,
    viewSlots: opts.slots ?? LIST,
    spec,
    properties: opts.properties,
  });
  const ids = Object.fromEntries(
    Object.entries(p.slots).map(([slot, list]) => [
      slot,
      list.map((x) => x.id),
    ]),
  );
  return { p, ids };
}

describe("resolvePlacement", () => {
  it("places a record: identity title, state lead, instant edge, prose line 2, rest trailing", () => {
    const { ids } = place([
      f("title", "label", { primary: true }),
      f("status", "state"),
      f("updated", "instant"),
      f("description", "prose"),
      f("model", "label"),
      f("cost", "quantity"),
    ]);
    expect(ids).toMatchObject({
      lead: ["status"],
      title: ["title"],
      edge: ["updated"],
      line2: ["description"],
      trail: ["model", "cost"],
      hidden: [],
    });
  });

  it("falls a second instant through to its next rule, and says so", () => {
    const { ids, p } = place([
      f("name", "label", { primary: true }),
      f("updated", "instant"),
      f("created", "instant"),
    ]);
    expect(ids.edge).toEqual(["updated"]);
    expect(ids.trail).toEqual(["created"]);
    expect(p.notes).toContain("created: edge taken → trail");
  });

  it("a second and third state fall to afterTitle", () => {
    const { ids } = place([
      f("name", "label", { primary: true }),
      f("lane", "state"),
      f("verdict", "state"),
    ]);
    expect(ids.lead).toEqual(["lane"]);
    expect(ids.afterTitle).toEqual(["verdict"]);
  });

  it("log: the time leads", () => {
    const { ids } = place(
      [
        f("text", "label", { primary: true }),
        f("t", "instant"),
        f("stream", "state"),
      ],
      { recipe: "log" },
    );
    expect(ids).toMatchObject({
      lead: ["t"],
      title: ["text"],
      afterTitle: ["stream"],
    });
  });

  it("inbox: a person is the title, the identity drops to line 2", () => {
    const { ids } = place(
      [
        f("subject", "label", { primary: true }),
        f("from", "person"),
        f("at", "instant"),
      ],
      { recipe: "inbox" },
    );
    expect(ids.title).toEqual(["from"]);
    expect(ids.line2).toEqual(["subject"]);
    expect(ids.edge).toEqual(["at"]);
  });

  it("ledger hides extra instants", () => {
    const { ids } = place(
      [
        f("name", "label", { primary: true }),
        f("ended", "instant"),
        f("started", "instant"),
      ],
      { recipe: "ledger" },
    );
    expect(ids.edge).toEqual(["ended"]);
    expect(ids.hidden).toEqual(["started"]);
  });

  it("promotes a title when the schema names none", () => {
    const { ids, p } = place([f("count", "quantity"), f("path", "identifier")]);
    expect(ids.title).toEqual(["path"]);
    expect(p.notes).toContain("no title → path promoted");
  });

  it("hides `visible: false`, and an unlisted field under a Properties list", () => {
    expect(
      place([
        f("name", "label", { primary: true }),
        f("x", "label", { visible: false }),
      ]).ids.hidden,
    ).toEqual(["x"]);
    expect(
      place(
        [f("name", "label", { primary: true }), f("x", "label")],
        {},
        {
          properties: [{ id: "name" }],
        },
      ).ids.hidden,
    ).toEqual(["x"]);
  });

  it("a surface pin wins over the recipe, and the recipe field falls through", () => {
    const { ids } = place(
      [
        f("name", "label", { primary: true }),
        f("created", "instant"),
        f("updated", "instant"),
      ],
      { place: { updated: "edge" } },
    );
    expect(ids.edge).toEqual(["updated"]);
    expect(ids.trail).toEqual(["created"]);
  });

  it("the user's slot wins over the surface's pin", () => {
    const { ids } = place(
      [
        f("name", "label", { primary: true }),
        f("model", "label"),
        f("at", "instant"),
      ],
      { place: { at: "edge" } },
      {
        properties: [
          { id: "name" },
          { id: "model", slot: "edge" },
          { id: "at" },
        ],
      },
    );
    expect(ids.edge).toEqual(["model"]);
    expect(ids.trail).toEqual(["at"]);
  });

  it("throws on an unknown pinned or emphasized field, and on two surface pins to one slot", () => {
    const fields = [f("a", "label"), f("b", "label")];
    expect(() => place(fields, { place: { nope: "edge" } })).toThrow(/nope/);
    expect(() => place(fields, { emphasis: ["nope"] })).toThrow(/nope/);
    expect(() => place(fields, { place: { a: "edge", b: "edge" } })).toThrow(
      /holds one field/,
    );
  });

  it("a slot the view does not draw falls through; a capped slot too", () => {
    const icons: ViewSlots = {
      lead: { capacity: 1, kinds: ["visual"] },
      title: { capacity: 1 },
    };
    const { ids } = place(
      [
        f("status", "state"),
        f("face", "visual"),
        f("name", "label", { primary: true }),
      ],
      {},
      { slots: icons },
    );
    expect(ids.lead).toEqual(["face"]);
    expect(ids.title).toEqual(["name"]);
    expect(ids.hidden).toEqual(["status"]);

    const gallery: ViewSlots = { ...LIST, trail: { capacity: 2 } };
    const g = place(
      [
        f("name", "label", { primary: true }),
        f("a", "label"),
        f("b", "label"),
        f("c", "label"),
      ],
      {},
      { slots: gallery },
    );
    expect(g.ids.trail).toEqual(["a", "b"]);
    expect(g.ids.hidden).toEqual(["c"]);
  });

  it("priority is slot rank then drawing order, emphasis first", () => {
    const fields = [
      f("name", "label", { primary: true }),
      f("a", "quantity"),
      f("b", "quantity"),
      f("at", "instant"),
    ];
    const { p } = place(fields);
    expect([...p.priority.keys()]).toEqual(["name", "at", "a", "b"]);
    const e = place(fields, { emphasis: ["b"] }).p;
    expect([...e.priority.keys()]).toEqual(["b", "name", "at", "a"]);
    // The least important trailing column drops first; the edge after them.
    const drop = (id: string, slot: "trail" | "edge") =>
      dropOrderOf(
        fields.find((x) => x.id === id)!,
        slot,
        p,
      )!;
    expect(drop("b", "trail")).toBeLessThan(drop("a", "trail"));
    expect(drop("a", "trail")).toBeLessThan(drop("at", "edge"));
  });

  it("aligns number-like kinds to the end unless the field says otherwise", () => {
    const fields = [
      f("n", "quantity"),
      f("s", "label"),
      f("m", "duration", { align: "center" }),
    ];
    const { p } = place(fields);
    expect(fieldAlign(fields[0]!, p)).toBe("end");
    expect(fieldAlign(fields[1]!, p)).toBe("start");
    expect(fieldAlign(fields[2]!, p)).toBe("center");
  });
});
