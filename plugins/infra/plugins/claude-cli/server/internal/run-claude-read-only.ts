import * as z4 from "zod/v4";
import {
  cliFlagFor,
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
   * What it answers with: the CLI is handed this schema as `--json-schema`,
   * and the answer is parsed with the same schema — one declaration, so the
   * two cannot disagree.
   */
  output: z4.ZodType<T, unknown>;
  timeoutMs: number;
  source: RunClaudePrintInput["source"];
}

/** The tail of `--output-format json`: the run's result record. */
const ResultRecordSchema = z4.object({
  type: z4.literal("result"),
  subtype: z4.string(),
  is_error: z4.boolean(),
  structured_output: z4.unknown().optional(),
  result: z4.string().optional(),
});

/**
 * The CLI's arguments for a read-only structured run — exported so a test can
 * pin that no tool beyond `READ_ONLY_TOOLS` is reachable.
 */
export function readOnlyArgs(
  cliFlag: string,
  jsonSchema: string,
  system: string | undefined,
): string[] {
  const args = [
    "--print",
    "--model",
    cliFlag,
    // The built-in tool set, exactly; `--restricted` drops anything that runs
    // code and confines file tools to the working directory, and ignores the
    // user/project settings (so no allow-list widens it); no MCP server loads;
    // anything that would prompt is denied.
    "--tools",
    READ_ONLY_TOOLS.join(","),
    "--restricted",
    "--strict-mcp-config",
    "--permission-mode",
    "dontAsk",
    "--no-session-persistence",
    "--output-format",
    "json",
    "--json-schema",
    jsonSchema,
  ];
  if (system) args.push("--system-prompt", system);
  return args;
}

/**
 * One `claude --print` that may READ `readDir` (Read / Grep / Glob, nothing
 * else) and answers with a value of `output` — for a background judgement
 * over the code (triage, classification) that needs to look around but must
 * never change anything. Throws `ClaudeCliError` on a refusal, timeout, an
 * error result or an answer the schema rejects.
 */
export async function runClaudeReadOnly<T>(
  input: RunClaudeReadOnlyInput<T>,
): Promise<T> {
  const resolvedModel = requireModel(input.tier, getModelCatalog());
  const jsonSchema = JSON.stringify(z4.toJSONSchema(input.output));
  const stdout = await invokeClaude({
    args: readOnlyArgs(cliFlagFor(resolvedModel), jsonSchema, input.system),
    cwd: input.readDir,
    input: {
      tier: input.tier,
      prompt: input.prompt,
      system: input.system,
      source: input.source,
    },
    timeoutMs: input.timeoutMs,
    resolvedModel,
  });
  return parseStructuredResult(stdout, input.output);
}

/**
 * The structured answer out of `--output-format json` stdout: one result
 * object, or (some CLI versions) the whole message stream as an array ending
 * with it.
 */
export function parseStructuredResult<T>(
  stdout: string,
  output: z4.ZodType<T, unknown>,
): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    throw new ClaudeCliError(
      `claude --print returned no JSON: ${stdout.slice(0, 500)}`,
    );
  }
  const record = Array.isArray(parsed) ? parsed.at(-1) : parsed;
  const result = ResultRecordSchema.safeParse(record);
  if (!result.success) {
    throw new ClaudeCliError(
      `claude --print returned no result record: ${stdout.slice(0, 500)}`,
    );
  }
  if (result.data.is_error || result.data.structured_output === undefined) {
    throw new ClaudeCliError(
      `claude --print ended ${result.data.subtype} without a structured answer: ${(result.data.result ?? "").slice(0, 500)}`,
    );
  }
  const answer = output.safeParse(result.data.structured_output);
  if (!answer.success) {
    throw new ClaudeCliError(
      `claude --print answered outside its schema: ${answer.error.message}`,
    );
  }
  return answer.data;
}
