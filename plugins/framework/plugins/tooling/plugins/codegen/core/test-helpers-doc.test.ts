import { afterAll, describe, expect, test } from "bun:test";
import {
  asAppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  collectTestHelpers,
  declarationSummary,
  renderTestHelpers,
} from "./test-helpers-doc";

const root = asAppPath(mkdtempSync(join(tmpdir(), "test-helpers-doc-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// The file set the helpers are listed from: every file `write` made.
const written = new Set<string>();
const files = { root, has: (rel: string) => written.has(rel) };

function write(rel: string, content: string): void {
  written.add(rel);
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

describe("collectTestHelpers", () => {
  test("lists each runtime's testing barrel with summaries and types", () => {
    write(
      "db/server/testing/index.ts",
      `// Barrel comment.\nexport { createDb, other as renamed } from "./create";\nexport type { Db } from "./create";\nexport { bare } from "../internal/bare";\n`,
    );
    write(
      "db/server/testing/create.ts",
      `/**\n * Creates a throwaway database. Dropped after the suite.\n *\n * @param x ignored\n */\nexport async function createDb() {}\n\nexport const other = 1;\nexport interface Db {}\n`,
    );
    write("db/server/internal/bare.ts", `export function bare() {}\n`);
    write("db/web/testing/index.ts", `export { Fake } from "./fake";\n`);
    write("db/web/testing/fake.tsx", `/** A fake. */\nexport class Fake {}\n`);

    const barrels = collectTestHelpers(
      {
        dir: joinAppPath(root, "db"),
        path: "x/plugins/db",
      },
      files,
    );
    expect(barrels).toEqual([
      {
        runtime: "web",
        specifier: "@plugins/x/plugins/db/web/testing",
        values: [{ name: "Fake", summary: "A fake." }],
        types: [],
      },
      {
        runtime: "server",
        specifier: "@plugins/x/plugins/db/server/testing",
        values: [
          { name: "bare" },
          { name: "createDb", summary: "Creates a throwaway database." },
          { name: "renamed" },
        ],
        types: ["Db"],
      },
    ]);

    expect(renderTestHelpers(barrels, "  ")).toEqual([
      "  - Test helpers:",
      "    - Web: `@plugins/x/plugins/db/web/testing`",
      "      - `Fake` — A fake.",
      "    - Server: `@plugins/x/plugins/db/server/testing`",
      "      - `bare`",
      "      - `createDb` — Creates a throwaway database.",
      "      - `renamed`",
      "      - Types: `Db`",
    ]);
  });

  test("a barrel outside the file set is not read", () => {
    write("ignored/web/testing/index.ts", `export { x } from "./x";\n`);
    written.delete("ignored/web/testing/index.ts");
    expect(
      collectTestHelpers(
        { dir: joinAppPath(root, "ignored"), path: "ignored" },
        files,
      ),
    ).toEqual([]);
  });

  test("a plugin without a testing barrel renders nothing", () => {
    write("plain/server/index.ts", `export const x = 1;\n`);
    const barrels = collectTestHelpers(
      {
        dir: joinAppPath(root, "plain"),
        path: "plain",
      },
      files,
    );
    expect(barrels).toEqual([]);
    expect(renderTestHelpers(barrels, "")).toEqual([]);
  });
});

describe("declarationSummary", () => {
  test("ignores a JSDoc that is not directly above the declaration", () => {
    expect(
      declarationSummary(
        `/** Other. */\nconst y = 1;\nexport const x = 2;\n`,
        "x",
      ),
    ).toBeUndefined();
  });

  test("an abbreviation does not end the sentence", () => {
    expect(
      declarationSummary(
        `/** Start a proxy (e.g. \`x\`) on a port. More text. */\nexport function start() {}\n`,
        "start",
      ),
    ).toBe("Start a proxy (e.g. `x`) on a port.");
  });

  test("single-line JSDoc without a period is taken whole", () => {
    expect(
      declarationSummary(
        `/** Test-only reset */\nexport function reset() {}\n`,
        "reset",
      ),
    ).toBe("Test-only reset");
  });
});
