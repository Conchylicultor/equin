import { cp } from "node:fs/promises";
import { stat } from "@plugins/packages/plugins/timed-fs/core";
import { basename, join } from "node:path";
import { getConfig } from "@plugins/config_v2/server";
import { listRetainedConversations } from "@plugins/tasks/plugins/tasks-core/server";
import { resolveConversationTranscriptPaths } from "@plugins/conversations/plugins/transcript-watcher/server";
import type { BackupSourceReport } from "@plugins/backup/core";
import { transcriptsSourceConfig } from "../../shared/config";

export async function assembleTranscripts(
  dir: string,
): Promise<BackupSourceReport> {
  const { enabled } = getConfig(transcriptsSourceConfig);

  if (!enabled) {
    return {
      id: "transcripts",
      name: "Transcripts",
      outcome: "skipped",
      items: [],
      sizeBytes: 0,
    };
  }

  let count = 0;
  let files = 0;
  let sizeBytes = 0;
  // Same retention scope the transcript-touch job keeps alive on disk (active,
  // plus every conversation of a held task): a backup that omitted held work
  // would restore a machine whose parked tasks have lost their history.
  for (const conv of await listRetainedConversations()) {
    // A conversation spans its whole session chain; backing up only the live tail
    // would lose every earlier segment. Chain files are distinct `<sessionId>.jsonl`
    // names, so flattening them into `dir` by basename cannot collide.
    const paths = await resolveConversationTranscriptPaths(conv.id);
    if (paths.length === 0) continue;
    for (const path of paths) {
      const dest = join(dir, basename(path));
      await cp(path, dest);
      sizeBytes += (await stat(dest)).size;
      files++;
    }
    count++;
  }

  return {
    id: "transcripts",
    name: "Transcripts",
    outcome: "included",
    items: [
      {
        label: "transcripts",
        detail: `${files} files across ${count} conversations`,
        count,
      },
    ],
    sizeBytes,
  };
}
