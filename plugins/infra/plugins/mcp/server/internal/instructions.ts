import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpToolContext } from "./mcp";
import { runContribution } from "./isolate";
import { instructionsRegistry } from "./registry";

/**
 * The JSON-RPC messages a POST body holds (one, or a batch). Reads a clone so
 * the transport still consumes the original body. Unparseable JSON holds none:
 * the transport answers it with its own JSON-RPC parse error.
 */
export async function bodyMessages(req: Request): Promise<unknown[]> {
  let body: unknown;
  try {
    body = await req.clone().json();
  } catch (err) {
    if (err instanceof SyntaxError) return [];
    throw err;
  }
  return Array.isArray(body) ? body : [body];
}

/** Whether the messages are (or contain) an `initialize` request. */
export function hasInitialize(messages: readonly unknown[]): boolean {
  return messages.some(isInitializeRequest);
}

/** Whether the messages are (or contain) a `tools/list` request. */
export function hasToolsList(messages: readonly unknown[]): boolean {
  return messages.some(
    (m) =>
      typeof m === "object" &&
      m !== null &&
      (m as { method?: unknown }).method === "tools/list",
  );
}

/**
 * Renders every `Mcp.instructions` contribution in id order, drops the ones
 * that returned `null`, and joins the rest with blank lines. `undefined` when
 * nothing was contributed, so the initialize result omits the field.
 *
 * A contribution that throws fails only its own section: the failure is
 * reported ({@link runContribution}) and the section is replaced by a notice
 * telling the agent it is missing — the connect, every tool and every other
 * section still go through.
 */
export async function renderInstructions(
  ctx: McpToolContext,
): Promise<string | undefined> {
  const contributions = [...instructionsRegistry.values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const sections = await Promise.all(
    contributions.map(async (c) => {
      const outcome = await runContribution(
        `instructions section "${c.id}"`,
        () => c.render(ctx),
      );
      return outcome.ok ? outcome.value : failedSectionNotice(c.id, outcome);
    }),
  );
  const text = sections
    .filter((s): s is string => s !== null && s.trim() !== "")
    .join("\n\n");
  return text === "" ? undefined : text;
}

/** What the agent reads in place of a section that failed to render. */
function failedSectionNotice(id: string, failure: { message: string }): string {
  return [
    `## Instructions section "${id}" unavailable`,
    "",
    `This section failed to render (${failure.message}) and has been reported. ` +
      "Its guidance is missing from this connection; every tool is still available.",
  ].join("\n");
}
