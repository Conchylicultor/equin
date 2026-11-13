import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { repoSnapshotOver } from "@plugins/framework/plugins/tooling/core";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  DRIZZLE_CONFIG_PATH,
  MIGRATIONS_DATA_DIR,
  MIGRATIONS_PLUGIN_DIR,
} from "@plugins/database/plugins/migrations/core";
import {
  closureRecord,
  gitBlobId,
} from "@plugins/plugin-meta/plugins/plugin-records/core";
import { inSyncRecordSpec } from "./in-sync-record";

// A throwaway checkout holding what the record is keyed by: schema files (one
// importing a helper), the drizzle config, the producer (at its real path, so
// the spec names it), `data/`, and the module graph's file-facts scan. The
// record's answer here is a counter: each `verdict()` says whether drizzle-kit
// would have run again (a miss) or the stored answer stood (a hit).
const root = mkdtempSync(join(tmpdir(), "migrations-in-sync-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const SCAN_PATH =
  "plugins/plugin-meta/plugins/plugin-records/core/internal/scan-imports.ts";
const PRODUCER =
  "plugins/framework/plugins/tooling/plugins/checks/plugins/migrations-in-sync/check/internal/drizzle-generate.ts";
const CONFIG = `${MIGRATIONS_PLUGIN_DIR}/${DRIZZLE_CONFIG_PATH}`;
// The fixture checkout's plugins, built from its plugins dir as data (no
// plugin of this checkout is named).
const P = "plugins";
const A = `${P}/a/server/internal/tables.ts`;
const A_DEP = `${P}/a/server/internal/columns.ts`;
const B = `${P}/b/server/internal/tables.ts`;
const DATA_SQL = `${MIGRATIONS_DATA_DIR}/20260101000000_00000000__init.sql`;
const SNAPSHOT = `${MIGRATIONS_DATA_DIR}/meta/schema.snapshot.json`;
const UNRELATED = `${P}/u/web/index.ts`;

const files = new Map<string, string>();
function write(rel: string, text: string): void {
  files.set(rel, text);
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

write(
  SCAN_PATH,
  readFileSync(
    resolve(
      import.meta.dir,
      "../../../../../../../../../plugin-meta/plugins/plugin-records/core/internal/scan-imports.ts",
    ),
    "utf8",
  ),
);
write(PRODUCER, "export const producer = 1;\n");
write(CONFIG, 'export default { schema: ["x"] };\n');
write(A_DEP, 'export const col = "id";\n');
write(A, 'import { col } from "./columns";\nexport const a = col;\n');
write(B, 'export const b = "b";\n');
write(DATA_SQL, "-- the first migration\n");
write(SNAPSHOT, '{"id":"s1"}\n');
write(UNRELATED, "export const u = 1;\n");

function repo() {
  return repoSnapshotOver(asAppPath(root), [...files.keys()].sort(), (p) => {
    const text = files.get(p);
    return text === undefined ? null : gitBlobId(text);
  });
}

let runs = 0;
async function verdict(): Promise<"ran" | "hit"> {
  const r = repo();
  const before = runs;
  const out = await closureRecord<{ kind: "in-sync" }, string>(
    r,
    inSyncRecordSpec(r),
    async () => {
      runs++;
      return { ok: true, value: { kind: "in-sync" } };
    },
  );
  if (!out.ok) throw new Error(out.error);
  return runs > before ? "ran" : "hit";
}

describe("migrations-in-sync record", () => {
  test("the spec names every schema file, the config and the producer", () => {
    const spec = inSyncRecordSpec(repo());
    expect([...spec.modules].sort()).toEqual([A, B, CONFIG, PRODUCER].sort());
    expect(spec.input.data.map(([p]) => p)).toEqual([DATA_SQL, SNAPSHOT]);
  });

  test("an edit outside every input is a lookup", async () => {
    expect(await verdict()).toBe("ran");
    expect(await verdict()).toBe("hit");
    write(UNRELATED, "export const u = 2;\n");
    expect(await verdict()).toBe("hit");
  });

  test("a schema edit runs drizzle-kit again", async () => {
    write(B, 'export const b = "b2";\n');
    expect(await verdict()).toBe("ran");
    expect(await verdict()).toBe("hit");
  });

  test("an edit to a module a schema file imports runs it again", async () => {
    write(A_DEP, 'export const col = "key";\n');
    expect(await verdict()).toBe("ran");
  });

  test("a new schema file runs it again", async () => {
    write(`${P}/c/server/internal/schema.ts`, "export const c = 1;\n");
    expect(await verdict()).toBe("ran");
  });

  test("an edit to data/ runs it again", async () => {
    write(SNAPSHOT, '{"id":"s2"}\n');
    expect(await verdict()).toBe("ran");
    write(`${MIGRATIONS_DATA_DIR}/20260102000000_11111111__more.sql`, "-- x\n");
    expect(await verdict()).toBe("ran");
  });

  test("an edit to the drizzle config or the producer runs it again", async () => {
    write(CONFIG, 'export default { schema: ["y"] };\n');
    expect(await verdict()).toBe("ran");
    write(PRODUCER, "export const producer = 2;\n");
    expect(await verdict()).toBe("ran");
    expect(await verdict()).toBe("hit");
  });
});
