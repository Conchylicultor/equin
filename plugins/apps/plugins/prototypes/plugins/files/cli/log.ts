import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { prototypesDir } from "@plugins/apps/plugins/prototypes/data-dirs";
import { openHistoryStore, type VersionEntry } from "../shared/history/store";

/**
 * `./equin prototype log <id> [-p]` — how a prototype got to where it is,
 * newest first: what each version was asked for, what the agent said it did,
 * and (with `-p`) the diff it made.
 *
 * This is the agent's way in to the history. The next agent iterating on a mock
 * reads it to see what was tried, in what order, and why — the same repo the
 * detail pane's version arrows step through, read straight off disk with no
 * backend running.
 */
const run: CliAction<[string], { patch?: boolean }> = async (id, opts) => {
  const store = openHistoryStore(prototypesDir.path);
  const read = await store.readHistory(id);
  if (read.kind === "no-such-prototype") {
    throw new Error(`no prototype ${id} in ${prototypesDir.path}`);
  }

  if (read.history.dirty) {
    console.log(
      "* Live · unsaved changes — the folder differs from the newest version",
    );
    console.log(
      `  (the next agent turn records them; or: ./equin prototype checkpoint ${id})`,
    );
    console.log("");
  }

  for (const entry of [...read.entries].reverse()) {
    printEntry(entry);
    if (opts.patch) {
      const patch = await store.readVersionPatch(id, entry.sha);
      if (patch.trim() !== "") console.log(`\n${patch.trimEnd()}`);
    }
    console.log("");
  }
};

function printEntry(entry: VersionEntry): void {
  const when = entry.at.slice(0, 16).replace("T", " ");
  console.log(
    `v${entry.n}  ${when}  ${entry.kind.padEnd(8)}  ${entry.subject}`,
  );
  const meta = [`sha ${entry.sha}`];
  if (entry.conversationId !== null) {
    meta.push(`conversation ${entry.conversationId}`);
  }
  console.log(`    ${meta.join("  ")}`);
  if (entry.body !== "") {
    console.log("");
    for (const line of entry.body.split("\n")) console.log(`    ${line}`);
  }
}

export default run;
