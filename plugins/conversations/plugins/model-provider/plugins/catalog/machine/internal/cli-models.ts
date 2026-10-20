import { tmpdir } from "node:os";
import { z } from "zod";
import { pickHostEnv } from "@plugins/infra/plugins/launcher/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";

// The Claude CLI's model menu, read through the Agent SDK's control protocol:
// one `initialize` control request on stdin, answered by one `control_response`
// line on stdout. The CLI answers it locally — no model is called, nothing is
// billed — and exits once stdin closes.

const REQUEST_ID = "init-1";

/** The control request, as the Agent SDK sends it. */
export const INITIALIZE_REQUEST = `${JSON.stringify({
  type: "control_request",
  request_id: REQUEST_ID,
  request: { subtype: "initialize" },
})}\n`;

/** The argv after the binary: stream-json both ways, nothing loaded or saved that the answer does not need. */
export const INITIALIZE_ARGS = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--strict-mcp-config",
  "--no-session-persistence",
] as const;

/**
 * One entry of the menu — only the fields this reads. Recorded (Claude Code
 * 2.1.287): `{"value":"sonnet","resolvedModel":"claude-sonnet-5-5","displayName":"Sonnet 5.5",…}`
 * for a family alias, `{"value":"claude-opus-4-8","resolvedModel":"claude-opus-4-8",…}`
 * for an older version the CLI still offers, and `{"value":"default",…}`.
 */
const CliModelSchema = z.object({
  /** What `--model` takes: an alias (`sonnet`, `default`) or a CLI model name. */
  value: z.string(),
  /** The CLI model name that value runs today. */
  resolvedModel: z.string(),
  displayName: z.string().optional(),
});
export type CliModel = z.infer<typeof CliModelSchema>;

/**
 * The `control_response` line. The menu sits in the INNER response (the outer
 * one is the control envelope). Unknown fields — the account, commands,
 * agents — are stripped, never read.
 */
const InitializeResponseSchema = z.object({
  type: z.literal("control_response"),
  response: z.discriminatedUnion("subtype", [
    z.object({
      subtype: z.literal("success"),
      request_id: z.literal(REQUEST_ID),
      response: z.object({ models: z.array(CliModelSchema) }),
    }),
    z.object({
      subtype: z.literal("error"),
      request_id: z.literal(REQUEST_ID),
      error: z.string(),
    }),
  ]),
});

/** The CLI did not answer with a menu this code can read: a failed run or a changed protocol. Never papered over. */
export class CliModelsError extends Error {
  constructor(message: string) {
    super(`reading the Claude CLI's model menu: ${message}`);
    this.name = "CliModelsError";
  }
}

export interface InitializeOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

/** The menu in one `initialize` run's output. Pure, so a recorded response can drive it. Throws {@link CliModelsError}. */
export function parseInitializeOutput(output: InitializeOutput): CliModel[] {
  if (output.timedOut)
    throw new CliModelsError(
      `no answer within ${INITIALIZE_TIMEOUT_MS / 1000}s`,
    );
  const line = output.stdout
    .split("\n")
    .find((l) => l.includes('"control_response"'));
  if (line === undefined)
    throw new CliModelsError(
      `exited ${output.exitCode} with no control_response: ${(output.stderr.trim() || output.stdout.trim() || "no output").slice(0, 300)}`,
    );
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    throw new CliModelsError(
      `the control_response is not JSON: ${err.message}`,
    );
  }
  const parsed = InitializeResponseSchema.safeParse(json);
  if (!parsed.success)
    throw new CliModelsError(
      `the control_response changed shape (${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")})`,
    );
  const { response } = parsed.data;
  if (response.subtype === "error")
    throw new CliModelsError(`the CLI refused initialize: ${response.error}`);
  return response.response.models;
}

/** CLI start-up (~1–3 s measured); a ceiling, not an estimate. */
const INITIALIZE_TIMEOUT_MS = 60_000;

/**
 * Ask the installed Claude CLI which models it offers: every family alias with
 * the version it resolves to, and every older version it still runs. Same
 * closed host environment an agent pane gets (`pickHostEnv`), so the answer
 * honours the user's own settings and env overrides.
 */
export async function readCliModels(
  bin: string,
  signal: AbortSignal,
): Promise<CliModel[]> {
  const r = await spawnCaptured([bin, ...INITIALIZE_ARGS], {
    cwd: tmpdir(),
    env: pickHostEnv(process.env),
    stdin: INITIALIZE_REQUEST,
    timeoutMs: INITIALIZE_TIMEOUT_MS,
    signal,
  });
  return parseInitializeOutput(r);
}
