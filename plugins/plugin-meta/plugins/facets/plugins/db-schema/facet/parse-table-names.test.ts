import { describe, expect, test } from "bun:test";
import { parseEntityRefNames, parseTableNames } from "./index";

// The refs the fixtures' `defineEntity(<ref>, …)` calls name their tables by —
// what `parseEntityRefNames` reads off `entityRef("<name>", …)` declarations.
const REFS = new Map([
  ["tasksEntityRef", "tasks"],
  ["mailMessageLabelsEntityRef", "mail_message_labels"],
  ["fooEntityRef", "foo"],
  ["ghost2EntityRef", "ghost2"],
  ["fake2EntityRef", "fake2"],
]);

function parse(src: string): Record<string, string> {
  const out = new Map<string, string>();
  parseTableNames(src, out, REFS);
  return Object.fromEntries(out);
}

describe("parseTableNames", () => {
  test("raw pgTable bindings", () => {
    expect(
      parse(`export const _foo = pgTable("foo", { id: text("id") });`),
    ).toEqual({ _foo: "foo" });
  });

  test("defineEntity binding re-exported via .table alias", () => {
    const src = `
      const tasksEntity = defineEntity(tasksEntityRef, {
        primaryKey: "id",
      });
      export const _tasks = tasksEntity.table;
    `;
    // Only the importable alias is reported; the intermediate entity var is dropped.
    expect(parse(src)).toEqual({ _tasks: "tasks" });
  });

  test("multi-line defineEntity call", () => {
    const src = `
      const mailMessageLabels = defineEntity(
        mailMessageLabelsEntityRef,
        {},
      );
      export const _mailMessageLabels = mailMessageLabels.table;
    `;
    expect(parse(src)).toEqual({ _mailMessageLabels: "mail_message_labels" });
  });

  test("inline defineEntity(...).table without a separate statement", () => {
    expect(
      parse(`export const _foo = defineEntity(fooEntityRef).table;`),
    ).toEqual({ _foo: "foo" });
  });

  test("intra-body <entity>.table references are not mistaken for aliases", () => {
    const src = `
      const tasksEntity = defineEntity(tasksEntityRef, {
        columns: {
          folderId: { references: { column: () => tasksEntity.table.id } },
        },
      });
      export const _tasks = tasksEntity.table;
    `;
    expect(parse(src)).toEqual({ _tasks: "tasks" });
  });

  test("mixed pgTable and defineEntity in one file", () => {
    const src = `
      export const _raw = pgTable("raw", {});
      const fooEntity = defineEntity(fooEntityRef);
      export const _foo = fooEntity.table;
    `;
    expect(parse(src)).toEqual({ _raw: "raw", _foo: "foo" });
  });

  // Comment/string/template-embedded declarations must NOT register a phantom
  // table — the false-positive class the full-mask + read-by-offset scan closes.
  test("commented-out pgTable / defineEntity is ignored", () => {
    const src = `
      // export const _ghost = pgTable("ghost", {});
      /* const ghostEntity = defineEntity(ghost2EntityRef);
         export const _ghost2 = ghostEntity.table; */
      export const _real = pgTable("real", {});
    `;
    expect(parse(src)).toEqual({ _real: "real" });
  });

  test("stringified / templated declaration is ignored", () => {
    const src = [
      'const snippet = "export const _fake = pgTable(\\"fake\\", {})";',
      "const tmpl = `const fakeEntity = defineEntity(fake2EntityRef); export const _f = fakeEntity.table;`;",
      'export const _real = pgTable("real", {});',
    ].join("\n");
    expect(parse(src)).toEqual({ _real: "real" });
  });

  test("entityRef declarations name their bindings' tables", () => {
    const out = new Map<string, string>();
    parseEntityRefNames(
      `export const fooEntityRef = entityRef("foo", fooFields);
       // const ghostRef = entityRef("ghost", f);
       const x = entityRef(\`dyn\`, f);`,
      out,
    );
    expect(Object.fromEntries(out)).toEqual({ fooEntityRef: "foo" });
  });
});
