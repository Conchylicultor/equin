import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { prototypesDir } from "@plugins/apps/plugins/prototypes/data-dirs";
import { openHistoryStore } from "../shared/history/store";

/**
 * `./equin prototype checkpoint <id> [-m <message>]` — record the folder
 * as a `manual` version now.
 *
 * Agent turns record versions on their own; an edit made outside one (by hand,
 * by a plain terminal Claude) otherwise waits as "unsaved changes" until the
 * next turn folds it in. Same store call as the end-of-turn job, straight
 * against the filesystem.
 */
const run: CliAction<[string], { message?: string }> = async (id, opts) => {
  const store = openHistoryStore(prototypesDir.path);
  const result = await store.checkpoint(id, {
    kind: "manual",
    subject: opts.message ?? "",
  });
  switch (result.kind) {
    case "no-such-prototype":
      throw new Error(`no prototype ${id} in ${prototypesDir.path}`);
    case "unchanged":
      console.log("unchanged — the folder matches the newest version");
      return;
    case "recorded":
      console.log(
        `recorded v${result.version.n}  ${result.version.sha.slice(0, 12)}  ${result.version.subject}`,
      );
      return;
  }
};

export default run;
