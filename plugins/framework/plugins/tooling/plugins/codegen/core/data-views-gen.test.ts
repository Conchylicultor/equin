import { describe, expect, test } from "bun:test";
import { scanDataViewIds } from "./data-views.scan";

describe("scanDataViewIds", () => {
  test("records every literal id, in source order", () => {
    const src = `
      import { defineDataView } from "x";
      export const Tasks = defineDataView<Task>("tasks.list", { fields });
      export const Runs = defineDataView('events.runs', { fields });
    `;
    expect(scanDataViewIds(src, "f.ts")).toEqual(["tasks.list", "events.runs"]);
  });

  test("an EMPTY literal id is recorded, matching the slot scanner", () => {
    // The old `[^"]+` regex dropped this while the slot scanner's `[^"]*` kept it,
    // so the two scanners disagreed about the same source shape.
    expect(scanDataViewIds(`defineDataView("", cfg);`, "f.ts")).toEqual([""]);
  });

  test("a marker in a comment, string or template is not a call", () => {
    const src = `
      import { defineDataView } from "x";
      // defineDataView(HOISTED)
      const doc = "call defineDataView(\\"z\\") to make one";
      const tmpl = \`defineDataView(other)\`;
      export const Real = defineDataView<Row>("real.view");
    `;
    expect(scanDataViewIds(src, "f.ts")).toEqual(["real.view"]);
  });

  test("a hoisted id throws, naming file, line and expression", () => {
    const src = `import { defineDataView } from "x";
const ID = "tasks.list";
export const Tasks = defineDataView<Task>(ID, { fields });
`;
    let message = "";
    try {
      scanDataViewIds(src, "plugins/tasks/web/list.tsx");
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      message = err.message;
    }
    expect(message).toContain("plugins/tasks/web/list.tsx:3");
    expect(message).toContain("defineDataView");
    expect(message).toContain("`ID, { fields }`");
  });

  test("an interpolated id throws rather than recording the template's interior", () => {
    // Escaped template: the fixture must hold the literal characters `${base}`
    // without this file interpolating them.
    const src = `export const V = defineDataView(\`\${base}.view\`, cfg);`;
    expect(() => scanDataViewIds(src, "f.ts")).toThrow(
      /not a static string literal/,
    );
  });

  test("same input → identical output", () => {
    const src = `defineDataView("b"); defineDataView("a");`;
    expect(scanDataViewIds(src, "f.ts")).toEqual(scanDataViewIds(src, "f.ts"));
  });
});
