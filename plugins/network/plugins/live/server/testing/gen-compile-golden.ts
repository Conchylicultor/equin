// Writes the compile-SQL golden (`compile-sql-golden.ts`, beside this file) to
// `plugins/network/plugins/live/server/testing/compile-sql-golden.json`, which
// `server/internal/compile-sql-golden.test.ts` reads and compares against:
//
//   ./equin run plugins/network/plugins/live/server/testing/gen-compile-golden.ts
//
// Run it from the code the golden is meant to pin (a refactor that must not
// change the SQL generates BEFORE the refactor), then review the fixture's
// diff. It sits in `server/testing/`, not `scripts/`, because the matrix drives
// the compilers through query-resource's recording `QueryDb` — a test helper,
// which only test code may import.

import { writeFileSync } from "node:fs";
import {
  COMPILE_SQL_GOLDEN_FILE,
  recordCompileGolden,
} from "./compile-sql-golden";

const path = COMPILE_SQL_GOLDEN_FILE;
writeFileSync(
  path,
  `${JSON.stringify(await recordCompileGolden(), null, 2)}\n`,
);
console.log(`wrote ${path}`);
