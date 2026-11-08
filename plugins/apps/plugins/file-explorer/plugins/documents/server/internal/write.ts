import {
  parseRelPath,
  type FileData,
} from "@plugins/infra/plugins/paths/plugins/data-files/core";
import { systemOrigin } from "@plugins/infra/plugins/request-origin/core";
import { documentsFiles } from "./roots";

const writer = systemOrigin("documents fixture");

/**
 * Documents as a fixture: path relative to the root (`Notes/ideas.md`) → the
 * file's bytes or text. Folders are what the paths imply.
 */
export type DocumentsFixture = Readonly<Record<string, FileData>>;

/**
 * Write a Documents fixture into a running host (a demo's seed, a test)
 * through the root's own writes — the same path any writer of the user's
 * Documents takes, so the root's watch pushes every file to what App data
 * shows. Refuses a fixture that is empty or names a path twice in two
 * spellings (an invalid path throws from `parseRelPath`).
 */
export async function writeDocumentsFixture(
  fixture: DocumentsFixture,
): Promise<void> {
  const entries = Object.entries(fixture);
  if (entries.length === 0)
    throw new Error("documents fixture: no files to write");
  for (const [path, data] of entries)
    await documentsFiles.write(parseRelPath(path), data, { writer });
}
