import { describe, expect, test } from "bun:test";
import { nullable } from "@plugins/fields/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { clientFields, rowKind } from "./row-kind";

// `rowKind` (rows that are not database data, declared by fields) and
// `clientFields` (fields whose values only the browser knows, declared once on
// an owner): what they derive, and every declaration they refuse. tsc refuses
// the misdeclarations below too — each is passed `as never` to reach the
// runtime check an untyped caller meets.

const files = rowKind("test.row-kind.files", {
  fields: {
    name: textField({ label: "Name", primary: true }),
    kind: enumTextField(["file", "dir"] as const, {
      label: "Kind",
      options: { file: { label: "File" }, dir: { label: "Directory" } },
    }),
    size: nullable(intField({ label: "Size" })),
  },
  carry: { fields: { path: textField() } },
  id: "path",
});

describe("rowKind", () => {
  test("is a collection with no server: a key, an id, every row key, the listed fields, no entity", () => {
    expect(files.kind).toBe("row-kind");
    expect(files.key).toBe("test.row-kind.files");
    expect(files.id).toBe("path");
    expect(files.from).toBeNull();
    expect(files.exposes).toBeNull();
    // Listed fields first, then the carried ones.
    expect([...files.rowKeys].sort()).toEqual(["kind", "name", "path", "size"]);
  });

  test("lists its fields in declaration order, each sortable, with its label, type, options and domain", () => {
    expect(Object.keys(files.fields)).toEqual(["name", "kind", "size"]);
    expect(files.fields.name).toMatchObject({
      id: "name",
      key: "name",
      label: "Name",
      primary: true,
      domain: "text",
      sortable: true,
    });
    expect(files.fields.kind.options).toEqual({
      file: { label: "File" },
      dir: { label: "Directory" },
    });
    expect(files.fields.size).toMatchObject({
      domain: "number",
      sortable: true,
    });
    // The carried id is on the row, in no list.
    expect(Object.hasOwn(files.fields, "path")).toBe(false);
  });

  test("a listed field with no label is refused", () => {
    expect(() =>
      rowKind("test.row-kind.unlabelled", {
        fields: { name: textField() },
        carry: { fields: { id: textField() } },
        id: "id",
      } as never),
    ).toThrow(/listed field "name" has no label/);
  });

  test("an id that is no row field is refused", () => {
    expect(() =>
      rowKind("test.row-kind.no-id", {
        fields: { name: textField({ label: "Name" }) },
        id: "id",
      } as never),
    ).toThrow(/the id "id" is not a field of the row/);
  });

  test("a field named twice (listed and carried) is refused", () => {
    expect(() =>
      rowKind("test.row-kind.twice", {
        fields: { name: textField({ label: "Name" }) },
        carry: { fields: { name: textField(), id: textField() } },
        id: "id",
      } as never),
    ).toThrow(/"name" is declared twice/);
  });
});

describe("clientFields", () => {
  test("declares its fields once on an owner: its key, id, section and listed fields in declaration order", () => {
    const git = clientFields(files, "git", {
      section: "Git",
      fields: {
        branch: nullable(textField({ label: "Branch" })),
        dirty: nullable(boolField({ label: "Dirty" })),
      },
    });
    expect(git.kind).toBe("client-fields");
    expect(git.owner).toBe("test.row-kind.files");
    expect(git.id).toBe("git");
    expect(git.section).toBe("Git");
    expect(Object.keys(git.listed)).toEqual(["branch", "dirty"]);
    expect(git.listed.branch).toMatchObject({
      label: "Branch",
      domain: "text",
      sortable: true,
      primary: false,
    });
    expect(git.listed.dirty.domain).toBe("boolean");
  });

  test("no `section` lists them with the owner's own fields", () => {
    const usage = clientFields(files, "usage", {
      fields: { opens: nullable(intField({ label: "Opens" })) },
    });
    expect(usage.section).toBeNull();
  });

  test("an id that is not a plain slug is refused", () => {
    for (const id of ["", "Git", "a b", "1x"]) {
      expect(() =>
        clientFields(files, id, {
          fields: { x: textField({ label: "X" }) },
        }),
      ).toThrow(/the id is not a plain slug/);
    }
  });

  test("an empty `section` is refused", () => {
    expect(() =>
      clientFields(files, "git", {
        section: "  ",
        fields: { x: textField({ label: "X" }) },
      }),
    ).toThrow(/an empty `section`/);
  });

  test("a field named like one of the owner's own is refused", () => {
    expect(() =>
      clientFields(files, "git", {
        fields: { name: textField({ label: "Name" }) },
      }),
    ).toThrow(/"name" is a field of the owner itself/);
  });

  test("a field with no label is refused: every client field is listed", () => {
    expect(() =>
      clientFields(files, "git", { fields: { branch: textField() } } as never),
    ).toThrow(/"branch" has no label/);
  });
});
