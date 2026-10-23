import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  isFieldValueEmpty,
  partitionCardFields,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import type { PrototypeMeta } from "@plugins/apps/plugins/prototypes/plugins/files/core";
import { galleryFields, joinGalleryRows } from "../internal/gallery-fields";
import type { PrototypeGalleryRow } from "../slots";

afterEach(cleanup);

const META: PrototypeMeta = {
  name: "proto-1789000000-abcd",
  rev: "r1",
  createdAt: Date.UTC(2026, 0, 1),
  modifiedAt: Date.UTC(2026, 0, 2),
  title: "Menu",
  blurb: "One design for every dropdown menu",
  viewport: { kind: "responsive" },
  mocks: { kind: "none" },
  options: [],
  problems: [],
};

function field(id: string): FieldDef<PrototypeGalleryRow> {
  const f = galleryFields.find((x) => x.id === id);
  if (!f) throw new Error(`no field ${id}`);
  return f;
}

function cellText(id: string, row: PrototypeGalleryRow): string {
  const node = field(id).cell?.(row);
  return render(<>{node}</>).container.textContent ?? "";
}

describe("joinGalleryRows", () => {
  it("joins each prototype's status and version count", () => {
    const [row] = joinGalleryRows(
      [META],
      { [META.name]: { done: true, pinned: false } },
      { [META.name]: 12 },
    );
    expect(row).toMatchObject({ done: true, pinned: false, versions: 12 });
  });

  it("a prototype without a recorded status or count: not done, count unknown", () => {
    const [row] = joinGalleryRows([META], {}, {});
    expect(row).toMatchObject({ done: false, pinned: false });
    expect(row!.versions).toBeUndefined();
  });
});

describe("galleryFields — the card's lines", () => {
  const visible = galleryFields.filter((f) => f.visible !== false);
  const card = partitionCardFields(visible);

  it("title, the problems mark, the blurb subtitle, edited + versions tokens", () => {
    expect(card.title?.id).toBe("title");
    expect(card.indicators.map((f) => f.id)).toEqual(["problems"]);
    expect(card.subtitle.map((f) => f.id)).toEqual(["blurb"]);
    expect(card.tokens.map((f) => f.id)).toEqual(["modifiedAt", "versions"]);
  });

  it("the folder id, created date and status are not shown", () => {
    for (const id of ["name", "createdAt", "status"]) {
      expect(field(id).visible).toBe(false);
    }
  });

  it("edited and versions carry their own icons", () => {
    expect(field("modifiedAt").icon).toBeDefined();
    expect(field("versions").icon).toBeDefined();
  });
});

describe("galleryFields — values", () => {
  const [row] = joinGalleryRows([META], {}, { [META.name]: 12 });

  it("versions reads as v12", () => {
    expect(cellText("versions", row!)).toBe("v12");
  });

  it("an unknown version count is omitted, never v0", () => {
    const [unknown] = joinGalleryRows([META], {}, {});
    expect(isFieldValueEmpty(field("versions"), unknown!)).toBe(true);
  });

  it("no problems: the mark is omitted; some: their count", () => {
    expect(isFieldValueEmpty(field("problems"), row!)).toBe(true);
    const broken = {
      ...row!,
      problems: [
        { path: "index.html", detail: "a" },
        { path: "", detail: "b" },
      ],
    };
    expect(isFieldValueEmpty(field("problems"), broken)).toBe(false);
    expect(cellText("problems", broken)).toBe("2");
  });

  it("status groups pinned above done", () => {
    const status = field("status").value!;
    expect(status({ ...row!, pinned: true, done: true })).toBe("pinned");
    expect(status({ ...row!, done: true })).toBe("done");
    expect(status(row!)).toBe("in-progress");
  });
});
