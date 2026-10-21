import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { stringifyConfigValue } from "../../core";
import type { ConfigProxy } from "../../core";
import type { JsonValue } from "../../core";

const HASH_RE = /^\/\/ @hash ([a-f0-9]+)\n/;

// This is the full read/write proxy used by the running server. Build-time
// checks that need a read-only variant without a server runtime define their
// own fs-backed proxy inline — core can't host fs code (it is browser-bundled).
export function jsoncConfigProxy(filePath: string): ConfigProxy {
  return {
    read() {
      if (!existsSync(filePath)) return null;
      const raw = readFileSync(filePath, "utf-8");
      const match = HASH_RE.exec(raw);
      // Every config file on disk must record the origin hash it was written
      // against (`// @hash` on line 1). The canonical writers (setConfig,
      // propagate) always emit it; a file without one is corrupt (truncated
      // write, bad hand-edit), not a benign "untracked" override. Fail loudly
      // rather than silently resolving it as a no-conflict override.
      if (!match) {
        throw new Error(
          `Config file is missing its "// @hash" header: ${filePath}. ` +
            `A hashless config file is corrupt — restore the header or delete the file.`,
        );
      }
      const hash = match[1]!;
      const body = raw.slice(match[0].length);
      const content = parseJsonc(body) as JsonValue;
      return { content, hash };
    },
    write(content: JsonValue, hash: string | null) {
      let str = "";
      if (hash !== null) str += `// @hash ${hash}\n`;
      str += stringifyConfigValue(content) + "\n";
      const tmp = `${filePath}.tmp-${randomUUID()}`;
      try {
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(tmp, str, "utf-8");
        renameSync(tmp, filePath);
      } catch (err) {
        try {
          unlinkSync(tmp);
        } catch (unlinkErr: unknown) {
          if ((unlinkErr as NodeJS.ErrnoException).code !== "ENOENT")
            throw unlinkErr;
        }
        throw err;
      }
    },
    exists() {
      return existsSync(filePath);
    },
  };
}

/**
 * Write exact bytes to `filePath`, atomically — the same temp-file + rename the
 * proxy's `write` uses, without the parse/serialise round trip.
 *
 * For restoring a config document from a captured snapshot. Bytes rather than
 * parsed content is the whole point: the `// @hash` header and any comment
 * legend come back byte-identical, where re-serialising a parsed document would
 * drop the comments and could produce a file the reader rejects as corrupt.
 */
export function writeRawAtomic(filePath: string, bytes: string): void {
  const tmp = `${filePath}.tmp-${randomUUID()}`;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(tmp, bytes, "utf-8");
    renameSync(tmp, filePath);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch (unlinkErr: unknown) {
      if ((unlinkErr as NodeJS.ErrnoException).code !== "ENOENT")
        throw unlinkErr;
    }
    throw err;
  }
}

/** Exact bytes of `filePath`, or `null` when it does not exist. */
export function readRawOrNull(filePath: string): string | null {
  return existsSync(filePath) ? readFileSync(filePath, "utf-8") : null;
}
