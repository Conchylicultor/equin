/**
 * Tests for the `no-bare-cargo` lint rule: an argv or shell string that spawns
 * cargo is flagged; naming it as data or prose is not.
 */

import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./no-bare-cargo";

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaVersion: "latest", sourceType: "module" },
  },
});

ruleTester.run(
  "no-bare-cargo",
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      // The word as data: a list of command names, a file-type table key.
      { code: `const names = new Set(["make", "cargo", "go"]);` },
      { code: `const t = { "cargo.toml": 1 };` },
      // Prose.
      { code: "throw new Error(`cargo build failed: ` + msg);" },
      { code: `const doc = "the shared cargo target dir";` },
      // The sanctioned spelling.
      {
        code: `const { argv, env } = cargoCommand(["update"]); spawnCaptured(argv, { env });`,
      },
      // A declared smoke argv is data the updates runner spawns.
      { code: `const smoke = { argv: ["cargo", "check"] };` },
    ],
    invalid: [
      { code: `spawnCaptured(["cargo", "build", "--release"]);`, errors: 1 },
      { code: "spawnCaptured([`cargo`, `check`]);", errors: 1 },
      {
        code: `run([join(home, ".cargo", "bin"), "x"]); spawn(["/opt/x/cargo", "b"]);`,
        errors: 1,
      },
      { code: `spawnCaptured(["sh", "-c", "cargo build && x"]);`, errors: 1 },
      { code: `const s = "cd crate && cargo build --release";`, errors: 1 },
      { code: "const s = `#!/bin/sh\\nexec cargo run -- $@`;", errors: 1 },
    ],
  },
);
