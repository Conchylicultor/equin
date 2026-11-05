/**
 * Split a `runtimeExceptions` entry (`"<zone>.<plugin id>.<folder> -> <zone>.<plugin id>.<folder>"`)
 * into its two sides. Throws on any other shape. The boundary checker and the
 * plugin-reference locator (`plugin-meta/plugin-refs`) both read the entries
 * through it.
 */
export function parseRuntimeException(expr: string): {
  source: string;
  target: string;
} {
  const parts = expr.split("->").map((s) => s.trim());
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `invalid runtime exception: "${expr}" — expected "source.runtime -> target.runtime"`,
    );
  }
  return { source: parts[0], target: parts[1] };
}
