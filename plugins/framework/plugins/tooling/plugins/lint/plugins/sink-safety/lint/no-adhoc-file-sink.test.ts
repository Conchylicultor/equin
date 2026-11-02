/**
 * Tests for the `no-adhoc-file-sink` lint rule. Run with `bun test`.
 *
 * The rule bans append-mode filesystem writers (a hand-rolled durable sink that
 * escapes the declared/bounded/enumerable invariant). It fires on: an fs
 * append/stream import specifier (incl. alias), member access on an fs namespace/
 * default import, a re-export of one, `Bun.file(x).writer()`, and an append
 * smuggled through a whole-file writer via `{ flag: "a" }`. Whole-file writes,
 * fs READ imports, and type-only imports stay valid.
 *
 * Fixtures embed the banned imports as RuleTester `code` STRINGS, so this test
 * file's own AST contains no real fs import — it is not self-flagged and needs no
 * allowlist entry.
 */

import rule from "./no-adhoc-file-sink";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

ruleTester.run("no-adhoc-file-sink", rule, {
  valid: [
    // Whole-file writes are fine — codegen, config, build artifacts.
    { code: `import { writeFileSync } from "node:fs"; writeFileSync(f, x);` },
    {
      code: `import { readFileSync, statSync } from "node:fs"; readFileSync(f);`,
    },
    // A whole-file write with a non-append flag stays valid.
    {
      code: `import { writeFileSync } from "fs"; writeFileSync(f, x, { flag: "w" });`,
    },
    // Type-only import of an append name never loads a value.
    { code: `import type { appendFileSync } from "node:fs";` },
    // An unrelated object with an appendFile method is not fs.
    { code: `myLogger.appendFile("hi");` },
    // A user function coincidentally named appendFileSync, not imported from fs.
    { code: `function appendFileSync() {} appendFileSync();` },
    // Bun.file used for reading, not `.writer()`.
    { code: `const t = await Bun.file(p).text();` },
    // Namespace import of fs but only a read member is used.
    { code: `import * as fs from "node:fs"; fs.readFileSync(f);` },
  ],
  invalid: [
    // Named append import.
    {
      code: `import { appendFileSync } from "node:fs";`,
      errors: [{ messageId: "adhocFileSink" }],
    },
    // Aliased append import — reported at the specifier regardless of local name.
    {
      code: `import { appendFileSync as af } from "fs"; af(f, x);`,
      errors: [{ messageId: "adhocFileSink" }],
    },
    // appendFile from fs/promises.
    {
      code: `import { appendFile } from "node:fs/promises";`,
      errors: [{ messageId: "adhocFileSink" }],
    },
    // createWriteStream.
    {
      code: `import { createWriteStream } from "fs";`,
      errors: [{ messageId: "adhocFileSink" }],
    },
    // Namespace import + member access.
    {
      code: `import * as fs from "node:fs"; fs.appendFileSync(f, x);`,
      errors: [{ messageId: "adhocFileSink" }],
    },
    // Default import + computed member access.
    {
      code: `import fsp from "node:fs/promises"; fsp["appendFile"](f, x);`,
      errors: [{ messageId: "adhocFileSink" }],
    },
    // Re-export laundering.
    {
      code: `export { appendFileSync } from "fs";`,
      errors: [{ messageId: "adhocFileSink" }],
    },
    // Bun stream sink.
    {
      code: `const w = Bun.file(p).writer(); w.write(x);`,
      errors: [{ messageId: "adhocFileSink" }],
    },
    // Append smuggled through a whole-file writer.
    {
      code: `import { writeFileSync } from "node:fs"; writeFileSync(f, x, { flag: "a" });`,
      errors: [{ messageId: "adhocFileSink" }],
    },
    // Append smuggled through Bun.write.
    {
      code: `Bun.write(f, x, { flags: "a+" });`,
      errors: [{ messageId: "adhocFileSink" }],
    },
  ],
});
