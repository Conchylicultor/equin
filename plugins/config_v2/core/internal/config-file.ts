import { parse as parseJsonc } from "jsonc-parser";
import type { JsonValue } from "./types";

/**
 * The `// @hash <digest>` header on line 1 of every config file: the origin
 * hash the document was written against. THE spelling — every reader of config
 * files (the runtime proxy, the build's generators, the checks, the ledger)
 * matches it through this one regex.
 */
export const CONFIG_HASH_RE = /^\/\/ @hash ([a-f0-9]+)\n/;

/**
 * Parse one committed / user config file's text: the header's hash and the
 * JSONC body. STRICT — a file without the header is corrupt (truncated write,
 * bad hand-edit), never an "unhashed" document, so it throws naming `where`
 * (a path, or a bundle key) instead of resolving as a no-conflict override.
 */
export function parseConfigFile(
  raw: string,
  where: string,
): { content: JsonValue; hash: string } {
  const match = CONFIG_HASH_RE.exec(raw);
  if (!match) {
    throw new Error(
      `Config file is missing its "// @hash" header: ${where}. ` +
        `A hashless config file is corrupt — restore the header or delete the file.`,
    );
  }
  return {
    content: parseJsonc(raw.slice(match[0].length)) as JsonValue,
    hash: match[1]!,
  };
}
