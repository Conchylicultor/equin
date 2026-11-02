/**
 * Tests for the `no-system-python` lint rule: an argv or shell string that runs
 * the machine's own Python is flagged; naming the language is not.
 */

import rule from "./no-system-python";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

// The system paths the rule bans, assembled so the fixtures hold no literal
// system path (paths:no-hardcoded-paths).
const USR_BIN = ["", "usr", "bin"].join("/");

const ruleTester = createRuleTester();

ruleTester.run("no-system-python", rule, {
  valid: [
    // The language's name, as data.
    { code: `const lang = { py: "python" };` },
    { code: `add("python", 3);` },
    // A data table whose first entry names the language is not an argv.
    { code: 'const cases = [["python", `import os`]];' },
    // Prose that starts with the word is not a command.
    { code: "throw new Error(`python -m x: exited 3`);" },
    { code: `const doc = "runs a python/ project with uv";` },
    // The python kind's own interpreter.
    { code: `spawnCaptured([join(ready.dir, "bin", "python"), "-m", mod]);` },
    { code: `spawnCaptured(["uv", "python", "find", "--managed-python"]);` },
  ],
  invalid: [
    { code: `spawnCaptured(["python3", "-m", "x"]);`, errors: 1 },
    { code: `spawnCaptured(["python", "x.py"]);`, errors: 1 },
    { code: `spawnCaptured(["${USR_BIN}/python3", "x.py"]);`, errors: 1 },
    { code: "spawnCaptured([`python3.12`, `x.py`]);", errors: 1 },
    { code: `spawnCaptured(["sh", "-c", "python3 -m x"]);`, errors: 1 },
    { code: `const s = '#!/bin/sh\\nexec python3 "$@"\\n';`, errors: 1 },
    { code: `const s = "#!${USR_BIN}/env python3\\nprint(1)";`, errors: 1 },
    { code: "const s = `cd /tmp && python -m x`;", errors: 1 },
  ],
});
