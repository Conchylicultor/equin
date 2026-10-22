import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { rewindConversationAt } from "@plugins/conversations/server";
import { rewindConversationEndpoint } from "../../core/endpoints";
import { rewindBackupsDir } from "../../data-dirs";

export const handleRewind = implementMachine(
  rewindConversationEndpoint,
  ({ params, body }) => {
    rewindBackupsDir.ensure();
    // `<conversationId>.<epochMs>.jsonl` — the name is the whole index: which
    // conversation the backup belongs to and when it was taken. The sweep ages
    // files out by mtime, so nothing else needs to remember them.
    const backupPath = rewindBackupsDir.file(
      `${params.id}.${Date.now()}.jsonl`,
    );
    return rewindConversationAt(params.id, body.uuid, backupPath);
  },
);
