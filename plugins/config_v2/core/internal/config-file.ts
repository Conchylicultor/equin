import {
  parse as parseJsonc,
  printParseErrorCode,
  type ParseError,
} from "jsonc-parser";
import type { ConfigFileContent } from "./config-proxy";
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

/**
 * Parse one USER-layer override file's text — the one config file a person or
 * an agent writes by hand (`~/.equin/state/config/<ns>/<tree>/<name>.jsonc`).
 *
 * The header is optional here, and its absence means something: the file was
 * written against the origin beside it, by a writer that had no reason to know
 * a content hash (`hash: null`, "unstamped"). The registry stamps it with that
 * origin's hash the first time it reads it (`readEntryValues`), and the
 * build's `propagate` stamps it with the origin it is about to replace — so an
 * unstamped override is applied at once and joins the conflict chain like any
 * other, instead of being refused while the app keeps serving the old value.
 *
 * Origins, ancestors and committed files stay strict (`parseConfigFile`): only
 * the build and the registry write them, always with a header.
 */
export function parseOverrideFile(raw: string): ConfigFileContent {
  const match = CONFIG_HASH_RE.exec(raw);
  const header = match ? match[0] : "";
  const errors: ParseError[] = [];
  const content = parseJsonc(raw.slice(header.length), errors, {
    allowTrailingComma: true,
  }) as JsonValue;
  const hash = match ? match[1]! : null;
  if (errors.length === 0) return { content, hash };
  // Hand-written text that does not parse: say where, in the author's own
  // line numbers (the header line included).
  return {
    content,
    hash,
    syntaxErrors: errors.map((e) => {
      const offset = header.length + e.offset;
      const line = raw.slice(0, offset).split("\n").length;
      return `JSONC syntax error: ${printParseErrorCode(e.error)} at line ${line}`;
    }),
  };
}
