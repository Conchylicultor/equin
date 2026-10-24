/**
 * The union SQL + routes snapshot (C6 of
 * research/2026-10-06-global-scoped-change-routing-p8-v3.md): every shape the
 * union compiler renders for a fixed three-arm declaration
 * (`server/testing/compile-union-golden.ts`) — window full / scoped /
 * `windowIdsOf` per tuple, order signatures, `:rows`, `:groups` — with its SQL
 * and params, routes, reverse probes, `usesOf` and folded rows, equals the
 * committed fixture byte for byte.
 *
 * The test only READS the fixture; a missing one fails. It is written by
 * `./equin run plugins/network/plugins/live/server/testing/gen-compile-union-golden.ts`,
 * from the code a refactor must not change.
 *
 * Run: `./equin test plugins/network/plugins/live`.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import {
  COMPILE_UNION_GOLDEN_FILE,
  recordUnionGolden,
} from "../testing/compile-union-golden";

type Record = { [half: string]: unknown };

function readGolden(): Record {
  if (!existsSync(COMPILE_UNION_GOLDEN_FILE)) {
    throw new Error(
      `the union snapshot is missing (${COMPILE_UNION_GOLDEN_FILE}) — generate it from the code it pins: ./equin run plugins/network/plugins/live/server/testing/gen-compile-union-golden.ts`,
    );
  }
  return JSON.parse(readFileSync(COMPILE_UNION_GOLDEN_FILE, "utf8")) as Record;
}

describe("union SQL + routes snapshot", () => {
  test("every shape renders exactly the committed fixture", async () => {
    const golden = readGolden();
    const actual = JSON.parse(
      JSON.stringify(await recordUnionGolden()),
    ) as Record;
    expect(Object.keys(actual)).toEqual(Object.keys(golden));
    // Each half compared as serialized text, so key order is pinned too.
    for (const half of Object.keys(golden)) {
      expect(`${half}\n${JSON.stringify(actual[half], null, 2)}`).toBe(
        `${half}\n${JSON.stringify(golden[half], null, 2)}`,
      );
    }
    // And the whole file, exactly as the generator writes it.
    expect(`${JSON.stringify(actual, null, 2)}\n`).toBe(
      readFileSync(COMPILE_UNION_GOLDEN_FILE, "utf8"),
    );
  });
});
