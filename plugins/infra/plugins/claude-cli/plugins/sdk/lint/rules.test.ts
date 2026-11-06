/**
 * Tests for the claude-sdk lint rules: a Claude Code session opened outside
 * claudeQuery, or the executable spawned by hand, is flagged.
 */

import noClaudeBinSpawn from "./no-claude-bin-spawn";
import noDirectSdkQuery from "./no-direct-sdk-query";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

ruleTester.run("no-direct-sdk-query", noDirectSdkQuery, {
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

ruleTester.run("no-claude-bin-spawn", noClaudeBinSpawn, {
  valid: [
    { code: `claudeQuery({ env, bin: bundledClaudeBin(), prompt, options });` },
    { code: `spawnCaptured(["git", "log"], opts);` },
    { code: `const bin = bundledClaudeBin();` },
    { code: `linkSync(realpathSync(bundledClaudeBin()), staging);` },
  ],
  invalid: [
    {
      code: `Bun.spawn([await bundledClaudeBin(), "--version"]);`,
      errors: [{ messageId: "spawn" }],
    },
    {
      code: `spawnCaptured([bundledClaudeBin(), "--print"], opts);`,
      errors: [{ messageId: "spawn" }],
    },
    {
      code: `Bun.spawn([bundledClaudeBin(), "--version"]);`,
      errors: [{ messageId: "spawn" }],
    },
    {
      code: `spawn(bundledClaudeBin(), ["auth", "status"]);`,
      errors: [{ messageId: "spawn" }],
    },
  ],
});
