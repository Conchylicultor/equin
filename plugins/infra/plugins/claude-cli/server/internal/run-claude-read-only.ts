import { z } from "zod";
import type { ClaudeQueryInput } from "@plugins/infra/plugins/claude-cli/plugins/sdk/server";
import {
  requireModel,
  type ModelTier,
} from "@plugins/conversations/plugins/model-provider/core";
import { getModelCatalog } from "@plugins/conversations/plugins/model-provider/plugins/catalog/server";
import {
  ClaudeCliError,
  invokeClaude,
  type RunClaudePrintInput,
} from "./run-claude-print";

/**
 * The only tools a read-only run has: it reads and searches files, nothing
 * else. No Bash, no Edit/Write, no web, no MCP — so "read-only" is what the
 * CLI can do, not what the prompt asks.
 */
export const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"] as const;

export interface RunClaudeReadOnlyInput<T> {
  tier: ModelTier;
  prompt: string;
  system?: string;
  /** The directory it may read (its working directory, and the only one). */
  readDir: string;
  /**
   * What it answers with: the session is handed this schema as its output format,
   * and the answer is parsed with the same schema — one declaration, so the
   * two cannot disagree.
   */
  output: z.ZodType<T, unknown>;
  timeoutMs: number;
  source: RunClaudePrintInput["source"];
}

/**
 * The session options of a read-only structured run — exported so a test can
 * pin that no tool beyond `READ_ONLY_TOOLS` is reachable.
 */
export function readOnlyOptions(
  readDir: string,
  output: z.ZodType<unknown, unknown>,
  system: string | undefined,
): ClaudeQueryInput["options"] {
  return {
    cwd: readDir,
    // The built-in tool set, exactly; `--restricted` drops anything that runs
    // code and confines file tools to the working directory, and ignores the
    // user/project settings (so no allow-list widens it); no MCP server loads;
    // anything that would prompt is denied.
    tools: [...READ_ONLY_TOOLS],
    extraArgs: { restricted: null },
    settingSources: [],
    strictMcpConfig: true,
    permissionMode: "dontAsk",
    outputFormat: {
      type: "json_schema",
      // Draft-07, not zod's default 2020-12: the CLI validates the schema with
      // a validator that only knows draft-07, and refuses any other `$schema`
      // ("no schema with key or ref …/draft/2020-12/schema").
      schema: z.toJSONSchema(output, { target: "draft-7" }),
    },
    ...(system ? { systemPrompt: system } : {}),
  };
}

/**
 * One Claude Code turn that may READ `readDir` (Read / Grep / Glob, nothing
 * else) and answers with a value of `output` — for a background judgement
 * over the code (triage, classification) that needs to look around but must
 * never change anything. Throws `ClaudeCliError` on a refusal, timeout, an
 * error result or an answer the schema rejects.
 */
export async function runClaudeReadOnly<T>(
  input: RunClaudeReadOnlyInput<T>,
): Promise<T> {
  const resolvedModel = requireModel(input.tier, getModelCatalog());
  return invokeClaude({
    options: readOnlyOptions(input.readDir, input.output, input.system),
    input: {
      tier: input.tier,
      prompt: input.prompt,
      system: input.system,
      source: input.source,
    },
    timeoutMs: input.timeoutMs,
    resolvedModel,
    answerOf: (result) =>
      parseStructuredOutput(result.structured_output, input.output),
  });
}

/** The structured answer of a successful result, checked against `output`. */
export function parseStructuredOutput<T>(
  structured: unknown,
  output: z.ZodType<T, unknown>,
): T {
  if (structured === undefined)
    throw new ClaudeCliError(
      "Claude Code ended its turn without a structured answer",
    );
  const answer = output.safeParse(structured);
  if (!answer.success) {
    throw new ClaudeCliError(
      `Claude Code answered outside its schema: ${answer.error.message}`,
    );
  }
  return answer.data;
}
