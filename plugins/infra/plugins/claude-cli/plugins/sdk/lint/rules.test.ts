/**
 * Tests for the claude-sdk lint rules: a Claude Code session opened outside
 * claudeQuery, or the executable spawned by hand, is flagged.
 */

import { describe, it } from "bun:test";
import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import noClaudeBinSpawn from "./no-claude-bin-spawn";
import noDirectSdkQuery from "./no-direct-sdk-query";

// Hand RuleTester bun's own describe/it, or it registers nothing under
// `./equin test`.
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaVersion: "latest", sourceType: "module" },
  },
});

type Rule = Parameters<RuleTester["run"]>[1];

ruleTester.run("no-direct-sdk-query", noDirectSdkQuery as unknown as Rule, {
  valid: [
    { code: `import type { Query } from "@anthropic-ai/claude-agent-sdk";` },
    {
      code: `import { type SDKMessage, type Options } from "@anthropic-ai/claude-agent-sdk";`,
    },
    { code: `import { query } from "./my-query";` },
    {
      code: `import { claudeQuery } from "@plugins/infra/plugins/claude-cli/plugins/sdk/server";`,
    },
  ],
  invalid: [
    {
      code: `import { query } from "@anthropic-ai/claude-agent-sdk";`,
      errors: [{ messageId: "direct" }],
    },
    {
      code: `import { query as q, type Options } from "@anthropic-ai/claude-agent-sdk";`,
      errors: [{ messageId: "direct" }],
    },
    {
      code: `import { unstable_v2_prompt } from "@anthropic-ai/claude-agent-sdk";`,
      errors: [{ messageId: "direct" }],
    },
    {
      code: `import * as sdk from "@anthropic-ai/claude-agent-sdk";`,
      errors: [{ messageId: "direct" }],
    },
  ],
});

ruleTester.run("no-claude-bin-spawn", noClaudeBinSpawn as unknown as Rule, {
  valid: [
    { code: `claudeQuery({ env, bin: requireClaudeBin(), prompt, options });` },
    { code: `spawnCaptured(["git", "log"], opts);` },
    { code: `const bin = requireClaudeBin();` },
    { code: `linkSync(realpathSync(requireClaudeBin()), staging);` },
  ],
  invalid: [
    {
      code: `spawnCaptured([requireClaudeBin(), "--print"], opts);`,
      errors: [{ messageId: "spawn" }],
    },
    {
      code: `Bun.spawn([resolveClaudeBin().path, "--version"]);`,
      errors: [{ messageId: "spawn" }],
    },
    {
      code: `spawn(requireClaudeBin(), ["auth", "status"]);`,
      errors: [{ messageId: "spawn" }],
    },
  ],
});
