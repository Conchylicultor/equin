import { describe, expect, test } from "bun:test";
import { scanDataViewIds } from "./data-views.scan";

const CORE = "@plugins/primitives/plugins/data-view/core";
const WEB = "@plugins/primitives/plugins/data-view/web";
const FILE = "plugins/tasks/web/list.tsx";

function message(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    return err.message;
  }
  return "";
}

describe("scanDataViewIds", () => {
  test("records every literal id, in source order", () => {
    const src = `
      import { defineDataView } from "${WEB}";
      export const Tasks = defineDataView<Task>("tasks.list", { fields });
      export const Runs = defineDataView('events.runs', { fields });
    `;
    expect(scanDataViewIds(src, FILE)).toEqual(["tasks.list", "events.runs"]);
  });

  test("an aliased or namespaced import is followed (the old text scan missed both)", () => {
    const src = `
      import { defineDataView as dv } from "${CORE}";
      import * as views from "${WEB}";
      export const A = dv("a.view");
      export const B = views.defineDataView("b.view");
    `;
    expect(scanDataViewIds(src, FILE)).toEqual(["a.view", "b.view"]);
  });

  test("a same-named function from another module is not a data view", () => {
    const src = `
      import { defineDataView } from "./local";
      export const X = defineDataView("not.a.view");
    `;
    expect(scanDataViewIds(src, FILE)).toEqual([]);
  });

  test("a marker in a comment, string or template is not a call", () => {
    const src = `
      import { defineDataView } from "${WEB}";
      // defineDataView(HOISTED)
      const doc = "call defineDataView(\\"z\\") to make one";
      const tmpl = \`defineDataView(other)\`;
      export const Real = defineDataView<Row>("real.view");
    `;
    expect(scanDataViewIds(src, FILE)).toEqual(["real.view"]);
  });

  test("a hoisted id throws, naming file and line", () => {
    const src = `import { defineDataView } from "${WEB}";
const ID = "tasks.list";
export const Tasks = defineDataView<Task>(ID, { fields });
`;
    const m = message(() => scanDataViewIds(src, FILE));
    expect(m).toContain(`${FILE}:3`);
    expect(m).toContain("data-views scan");
  });

  test("an interpolated id throws rather than recording the template's interior", () => {
    const src = `import { defineDataView } from "${WEB}";
export const V = defineDataView(\`\${base}.view\`, cfg);`;
    expect(message(() => scanDataViewIds(src, FILE))).toContain(`${FILE}:2`);
  });

  test("defineDataView passed as a value throws", () => {
    const src = `import { defineDataView } from "${WEB}";
export const make = [defineDataView];`;
    expect(message(() => scanDataViewIds(src, FILE))).toContain(`${FILE}:2`);
  });

  test("a re-export outside the data-view plugin throws", () => {
    const src = `export { defineDataView } from "${CORE}";`;
    expect(message(() => scanDataViewIds(src, FILE))).toContain(FILE);
  });

  test("same input → identical output", () => {
    const src = `import { defineDataView } from "${WEB}";
defineDataView("b"); defineDataView("a");`;
    expect(scanDataViewIds(src, FILE)).toEqual(scanDataViewIds(src, FILE));
  });
});
