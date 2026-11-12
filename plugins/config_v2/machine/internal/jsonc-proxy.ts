import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { readFile } from "@plugins/packages/plugins/timed-fs/core";
import { randomUUID } from "node:crypto";
import { basename, dirname } from "node:path";
import {
  parseConfigFile,
  parseOverrideFile,
  stringifyConfigValue,
} from "../../core";
import type {
  ConfigDocumentFile,
  ConfigFileContent,
  JsonValue,
} from "../../core";
import {
  appPathParent,
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

// The user layer's file I/O, used by the running server's file store. Every
// call is asynchronous: a backend's thread never waits on the disk. Build-time
// checks that need a read-only variant without a server runtime define their
// own fs-backed proxy inline — core can't host fs code (it is browser-bundled).

/**
 * One config file's parsed content, or `null` when it does not exist.
 *
 * An origin or ancestor must record the origin hash it was written against
 * (`// @hash` on line 1): only the build and the registry write them, always
 * with one, so a file without it is corrupt (a bad hand-edit) and the strict
 * parse throws. An OVERRIDE is the file people and agents write by hand: one
 * without a header is unstamped — written against the origin beside it — and
 * reads as `hash: null` for the registry to stamp (`parseOverrideFile`).
 */
export async function readConfigFile(
  filePath: AppPath,
  file: ConfigDocumentFile,
): Promise<ConfigFileContent | null> {
  const text = await readRawOrNull(filePath);
  if (text === null) return null;
  return file === "override"
    ? parseOverrideFile(text)
    : parseConfigFile(text, filePath);
}

/** The bytes a config file holds for `content` written against `hash`. */
export function renderConfigFile(
  content: JsonValue,
  hash: string | null,
): string {
  let str = "";
  if (hash !== null) str += `// @hash ${hash}\n`;
  str += stringifyConfigValue(content) + "\n";
  return str;
}

/** Write one config file, atomically (temp file + rename). */
export async function writeConfigFile(
  filePath: AppPath,
  content: JsonValue,
  hash: string | null,
): Promise<void> {
  await writeRawAtomic(filePath, renderConfigFile(content, hash));
}

/**
 * Write exact bytes to `filePath`, atomically — a temp file renamed into place,
 * so the inode changes on every write (the store's stamp relies on it).
 *
 * Also for restoring a config document from a captured snapshot. Bytes rather
 * than parsed content is the whole point there: the `// @hash` header and any
 * comment legend come back byte-identical, where re-serialising a parsed
 * document would drop the comments and could produce a file the reader rejects
 * as corrupt.
 */
export async function writeRawAtomic(
  filePath: AppPath,
  bytes: string,
): Promise<void> {
  const tmp = joinAppPath(
    appPathParent(filePath),
    `${basename(filePath)}.tmp-${randomUUID()}`,
  );
  try {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(tmp, bytes, "utf-8");
    await rename(tmp, filePath);
  } catch (err) {
    try {
      await unlink(tmp);
    } catch (unlinkErr: unknown) {
      if ((unlinkErr as NodeJS.ErrnoException).code !== "ENOENT")
        throw unlinkErr;
    }
    throw err;
  }
}

/** Exact bytes of `filePath`, or `null` when it does not exist. */
export async function readRawOrNull(filePath: AppPath): Promise<string | null> {
  try {
    return await readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
