import { tmpdir } from "node:os";
import { z } from "zod";
import { SYSTEM_ACCOUNT_ID } from "@plugins/infra/plugins/claude-cli/plugins/accounts/core";
import {
  claudeSessionEnv,
  readClaudeInitialize,
} from "@plugins/infra/plugins/claude-cli/plugins/sdk/server";

// The Claude CLI's model menu, read through the Agent SDK: one session that
// sends no prompt and reads the menu off its `initialize` answer
// (`readClaudeInitialize`). Answered locally — no model is called, nothing is
// billed.

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

/** The menu, as `initialize` answers it. Unknown fields are stripped, never read. */
const MenuSchema = z.array(CliModelSchema);

/** The CLI did not answer with a menu this code can read: a failed run or a changed protocol. Never papered over. */
export class CliModelsError extends Error {
  constructor(message: string) {
    super(`reading the Claude CLI's model menu: ${message}`);
    this.name = "CliModelsError";
  }
}

/** The menu out of `initialize`'s `models`. Pure, so a recorded answer can drive it. Throws {@link CliModelsError}. */
export function parseInitializeModels(models: unknown): CliModel[] {
  const parsed = MenuSchema.safeParse(models);
  if (!parsed.success)
    throw new CliModelsError(
      `the menu changed shape (${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")})`,
    );
  return parsed.data;
}

/** CLI start-up (~1–3 s measured); a ceiling, not an estimate. */
const INITIALIZE_TIMEOUT_MS = 60_000;

/**
 * Ask the installed Claude CLI which models it offers: every family alias with
 * the version it resolves to, and every older version it still runs. On the
 * computer's own login (a token account's menu is narrower — it carries no
 * claude.ai sign-in), under the user's own settings and env overrides.
 */
export async function readCliModels(
  bin: string,
  signal: AbortSignal,
): Promise<CliModel[]> {
  let init;
  try {
    init = await readClaudeInitialize({
      env: await claudeSessionEnv(SYSTEM_ACCOUNT_ID),
      bin,
      cwd: tmpdir(),
      timeoutMs: INITIALIZE_TIMEOUT_MS,
      signal,
    });
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    throw new CliModelsError(err.message);
  }
  return parseInitializeModels(init.models);
}
