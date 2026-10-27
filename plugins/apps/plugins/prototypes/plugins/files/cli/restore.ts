import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { prototypesDir } from "@plugins/apps/plugins/prototypes/data-dirs";
import {
  isVersionSha,
  type HistoryStore,
} from "../server/internal/history-store";
import { cliHistory } from "./tree";

/**
 * `./equin prototype restore <id> <vN|sha>` — the detail pane's Restore
 * button, from a terminal: unsaved changes are saved as "Before restore", the
 * old files are written back, and "Restored vN" is recorded. Nothing is lost,
 * so a restore is itself undone by restoring the "Before restore" version.
 */
export const restorePrototypeAction: CliAction<
  [string, string],
  object
> = async (id, version) => {
  const store = cliHistory();
  const sha = await resolveVersion(store, id, version);
  const result = await store.restoreVersion(id, sha);
  switch (result.kind) {
    case "no-such-prototype":
      throw new Error(`no prototype ${id} in ${prototypesDir.path}`);
    case "unknown-version":
      throw new Error(
        `${version} is not a version of ${id} — see ./equin prototype log ${id}`,
      );
    case "restored":
      console.log(
        `v${result.version.n}  ${result.version.sha.slice(0, 12)}  ${result.version.subject}`,
      );
      return;
  }
};

/** `vN` (the number `prototype log` prints) or a sha → the sha to restore. */
async function resolveVersion(
  store: HistoryStore,
  id: string,
  version: string,
): Promise<string> {
  const numbered = /^v(\d+)$/.exec(version);
  if (numbered) {
    const read = await store.readHistory(id);
    if (read.kind === "no-such-prototype") {
      throw new Error(`no prototype ${id} in ${prototypesDir.path}`);
    }
    const entry = read.history.versions[Number(numbered[1])];
    if (entry === undefined) {
      throw new Error(
        `${id} has no ${version} — its versions are v0…v${read.history.versions.length - 1}`,
      );
    }
    return entry.sha;
  }
  if (!isVersionSha(version)) {
    throw new Error(`not a version: ${version} — pass vN or a commit sha`);
  }
  return version;
}
