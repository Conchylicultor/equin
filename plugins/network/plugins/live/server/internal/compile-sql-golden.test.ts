/**
 * The compile-SQL golden: every shape the bounded and grouping compilers render
 * for a fixed matrix of declarations (`server/testing/compile-sql-golden.ts`) —
 * full, scoped, `windowIdsOf`, point, reverse `resolve` and groups SQL and
 * params, the routes, `usesOf`, order signatures, folded output, and how many
 * times each tuple's `where` / `orderBy` is resolved — equals the committed
 * fixture byte for byte.
 *
 * The test only READS the fixture; a missing one fails. It is written by
 * `./equin run plugins/network/plugins/live/server/testing/gen-compile-golden.ts`,
 * from the code a refactor must not change.
 *
 * Run: `./equin test plugins/network/plugins/live`.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import {
  COMPILE_SQL_GOLDEN_FILE,
  recordCompileGolden,
} from "../testing/compile-sql-golden";

type Record = { [group: string]: { [name: string]: unknown } };

function readGolden(): Record {
  if (!existsSync(COMPILE_SQL_GOLDEN_FILE)) {
    throw new Error(
      `the compile-SQL golden is missing (${COMPILE_SQL_GOLDEN_FILE}) — generate it from the code it pins: ./equin run plugins/network/plugins/live/server/testing/gen-compile-golden.ts`,
    );
  }
  return JSON.parse(readFileSync(COMPILE_SQL_GOLDEN_FILE, "utf8")) as Record;
}

describe("compile-SQL golden", () => {
  test("every case renders exactly the committed fixture", async () => {
    const golden = readGolden();
    // A JSON round trip: the comparison is of what the fixture can hold.
    const actual = JSON.parse(
      JSON.stringify(await recordCompileGolden()),
    ) as Record;
    expect(Object.keys(actual)).toEqual(Object.keys(golden));
    // Each case compared as serialized text, so object key order (wire rows,
    // routes, server options) is pinned too — `toEqual` would ignore it.
    for (const group of Object.keys(golden)) {
      expect(Object.keys(actual[group]!)).toEqual(Object.keys(golden[group]!));
      for (const name of Object.keys(golden[group]!)) {
        expect(
          `${group}/${name}\n${JSON.stringify(actual[group]![name], null, 2)}`,
        ).toBe(
          `${group}/${name}\n${JSON.stringify(golden[group]![name], null, 2)}`,
        );
      }
    }
    // And the whole file, exactly as the generator writes it.
    expect(`${JSON.stringify(actual, null, 2)}\n`).toBe(
      readFileSync(COMPILE_SQL_GOLDEN_FILE, "utf8"),
    );
  });
});
