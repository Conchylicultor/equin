// Writes the union SQL + routes snapshot (`compile-union-golden.ts`, beside
// this file) to
// `plugins/network/plugins/live/server/testing/compile-union-golden.json`,
// which `server/internal/compile-union-golden.test.ts` reads and compares
// against:
//
//   ./equin run plugins/network/plugins/live/server/testing/gen-compile-union-golden.ts
//
// Run it from the code the snapshot is meant to pin (a refactor that must not
// change the union's SQL or routes generates BEFORE the refactor), then review
// the fixture's diff. In `server/testing/` for the reason the compile-SQL
// golden's generator is: it drives the compiler through query-resource's
// recording `QueryDb`, a test helper.

import { writeFileSync } from "node:fs";
import {
  COMPILE_UNION_GOLDEN_FILE,
  recordUnionGolden,
} from "./compile-union-golden";

const path = COMPILE_UNION_GOLDEN_FILE;
writeFileSync(path, `${JSON.stringify(await recordUnionGolden(), null, 2)}\n`);
console.log(`wrote ${path}`);
