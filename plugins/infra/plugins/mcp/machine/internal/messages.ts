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

/** Whether the messages are (or contain) a `tools/list` request. */
export function hasToolsList(messages: readonly unknown[]): boolean {
  return messages.some(
    (m) =>
      typeof m === "object" &&
      m !== null &&
      (m as { method?: unknown }).method === "tools/list",
  );
}
