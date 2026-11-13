import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { repoFilesOver } from "@plugins/framework/plugins/tooling/core";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { MIGRATIONS_PLUGIN_DIR } from "@plugins/database/plugins/migrations/core";
import { askSchemaFiles, type SchemaFileAnswer } from "./schema-question";

// A throwaway checkout: schema files (one importing a helper, one that throws
// at load, two registering a name in one shared registry — the way two tables
// declaring one derived updatedAt collide) and a question module. No copy of
// the probe host or of the module graph's scan: those are code, read and run
// from the checkout this test runs from. Each `repo()` is a fresh file set
// over the disk as it is now — the way every check pass takes one — so an
// edit between two asks is seen by the second.
const root = mkdtempSync(join(tmpdir(), "schema-question-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
// The host runs from the migrations plugin's dir, as drizzle-kit does: every
// checkout has it.
mkdirSync(join(root, MIGRATIONS_PLUGIN_DIR), { recursive: true });

// The fixture checkout's plugins, built from its plugins dir as data (no
// plugin of this checkout is named).
const P = "plugins";
const QUESTION = `${P}/q/check/q.question.ts`;
const A = `${P}/a/server/internal/tables.ts`;
const A_DEP = `${P}/a/server/internal/dep.ts`;
const B = `${P}/b/server/internal/tables.ts`;
const BROKEN = `${P}/c/server/internal/tables.ts`;
const REGISTRY = `${P}/r/server/internal/registry.ts`;
const CLAIM_FIRST = `${P}/d/server/internal/tables.ts`;
const CLAIM_SECOND = `${P}/e/server/internal/tables.ts`;
const UNRELATED = `${P}/u/web/index.ts`;

function write(rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

write(
  QUESTION,
  "export default { answer: (_file, exports, input) => ({ value: exports.value, input }) };\n",
);
write(A_DEP, "export const v = 1;\n");
write(A, 'import { v } from "./dep";\nexport const value = "a" + v;\n');
write(B, 'export const value = "b1";\n');
write(BROKEN, 'throw new Error("this schema file cannot load");\n');
write(
  REGISTRY,
  "const claimed = new Set();\nexport function claim(n) {\n  if (claimed.has(n)) throw new Error(n + ' claimed twice');\n  claimed.add(n);\n}\n",
);
write(
  CLAIM_FIRST,
  'import { claim } from "../../../r/server/internal/registry";\nclaim("x");\nexport const value = "d";\n',
);
write(
  CLAIM_SECOND,
  'import { claim } from "../../../r/server/internal/registry";\nclaim("x");\nexport const value = "e";\n',
);
write(UNRELATED, "export const u = 1;\n");

function repo() {
  return repoFilesOver(
    asAppPath(root),
    [
      QUESTION,
      A,
      A_DEP,
      B,
      BROKEN,
      REGISTRY,
      CLAIM_FIRST,
      CLAIM_SECOND,
      UNRELATED,
    ].sort(),
  );
}

type Answer = { value: string; input: string };

async function ask(input: (file: string) => string = () => "in") {
  const r = await askSchemaFiles<Answer, string>(repo(), {
    name: "test",
    module: `file://${join(root, QUESTION)}`,
    files: [A, B, BROKEN, CLAIM_FIRST, CLAIM_SECOND],
    input,
  });
  if (r.kind !== "ok") throw new Error(r.message);
  return r;
}

const loaded = (answer: Answer): SchemaFileAnswer<Answer> => ({
  kind: "loaded",
  answer,
});

describe("askSchemaFiles", () => {
  test("answers each file in the probe host; a load error is the file's answer", async () => {
    const r = await ask();
    expect(r.computed).toBe(true);
    expect(r.answers.get(A)).toEqual(loaded({ value: "a1", input: "in" }));
    expect(r.answers.get(B)).toEqual(loaded({ value: "b1", input: "in" }));
    const broken = r.answers.get(BROKEN);
    expect(broken?.kind).toBe("load-failed");
    // Named repo-relative: a record names no checkout.
    if (broken?.kind === "load-failed") {
      expect(broken.error).toContain("this schema file cannot load");
      expect(broken.error).not.toContain(root);
    }
    // The files share one process, as under drizzle-kit: the second claim of
    // one name throws.
    expect(r.answers.get(CLAIM_FIRST)).toEqual(
      loaded({ value: "d", input: "in" }),
    );
    expect(r.answers.get(CLAIM_SECOND)?.kind).toBe("load-failed");
  });

  test("an unchanged file set is a record: nothing loads", async () => {
    expect((await ask()).computed).toBe(false);
  });

  test("an edit no schema file's closure reaches is a record", async () => {
    write(UNRELATED, "export const u = 2;\n");
    expect((await ask()).computed).toBe(false);
  });

  test("an edit to a schema file is a new answer", async () => {
    write(B, 'export const value = "b2";\n');
    const r = await ask();
    expect(r.computed).toBe(true);
    expect(r.answers.get(B)).toEqual(loaded({ value: "b2", input: "in" }));
  });

  test("an edit to a module a schema file imports is a new answer", async () => {
    write(A_DEP, "export const v = 2;\n");
    const r = await ask();
    expect(r.computed).toBe(true);
    expect(r.answers.get(A)).toEqual(loaded({ value: "a2", input: "in" }));
  });

  test("fixing one schema file re-answers another whose load it broke", async () => {
    // CLAIM_SECOND's failure came from CLAIM_FIRST, outside its own closure:
    // a key over CLAIM_SECOND alone would keep serving the stale failure.
    write(
      CLAIM_FIRST,
      'import { claim } from "../../../r/server/internal/registry";\nclaim("y");\nexport const value = "d";\n',
    );
    const r = await ask();
    expect(r.computed).toBe(true);
    expect(r.answers.get(CLAIM_SECOND)).toEqual(
      loaded({ value: "e", input: "in" }),
    );
  });

  test("a file's input is part of the key", async () => {
    const r = await ask((f) => (f === A ? "other" : "in"));
    expect(r.computed).toBe(true);
    expect(r.answers.get(A)).toEqual(loaded({ value: "a2", input: "other" }));
  });

  test("an edit to the question module is a new answer", async () => {
    write(
      QUESTION,
      'export default { answer: (_file, exports, input) => ({ value: exports.value + "!", input }) };\n',
    );
    const r = await ask();
    expect(r.computed).toBe(true);
    expect(r.answers.get(B)).toEqual(loaded({ value: "b2!", input: "in" }));
  });

  test("a question that throws fails its own ask", async () => {
    write(
      QUESTION,
      'export default { answer: () => { throw new Error("question bug"); } };\n',
    );
    const r = await askSchemaFiles<Answer, string>(repo(), {
      name: "test",
      module: `file://${join(root, QUESTION)}`,
      files: [A, B],
    });
    expect(r.kind).toBe("probe-failed");
    if (r.kind === "probe-failed") expect(r.message).toContain("question bug");
  });
});
