import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defineScratchProfile } from "@plugins/conversations/plugins/workspace/server";
import { getAttachment } from "@plugins/infra/plugins/attachments/server";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/core";
import { transcriptionDep } from "../../deps";
import { awaitDepReady } from "./dep-ready";
import { transcriptionInstructions } from "./instructions";
import {
  inputFilePath,
  ProfileInputSchema,
  TRANSCRIPTION_PROFILE_ID,
} from "./profile-input";
import { SUBMIT_TOOL } from "../../core";

/** The `st` executable in this checkout (the wrapper's target). */
const ST_BIN = join(
  REPO_ROOT,
  "plugins/apps/plugins/sonata/plugins/transcription/bin/st",
);

/** POSIX single-quoting, for a path written into the wrapper script. */
function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * The agent's `./bin/st`: the checkout's `bin/st` with `ST_PYTHON` pointing at
 * the installed env, so the instructions name one relative command.
 */
function stWrapper(python: string): string {
  return `#!/bin/sh
ST_PYTHON=${shellQuote(python)} exec ${shellQuote(ST_BIN)} "$@"
`;
}

async function copyInputs(
  dir: string,
  files: readonly { attachmentId: string; name: string }[],
): Promise<void> {
  for (const [i, f] of files.entries()) {
    const att = await getAttachment(f.attachmentId);
    if (!att) {
      throw new Error(
        `[transcription] attachment not found: ${f.attachmentId}`,
      );
    }
    const dest = join(dir, inputFilePath(i, f.name));
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(att.diskPath, dest);
  }
}

/**
 * The transcribing agent's workspace: a scratch directory whose CLAUDE.md is
 * the transcription instructions, `bin/st` (the toolkit, on its installed
 * env) and, for uploads, the files under `input/`. It sees only the submit
 * tool and `flag_raise` — no `exit_clean`: the agent ends its turn once it
 * submitted, so the conversation stays open for the user's corrections (Sonata
 * hosts it as an agent thread), and its task derives done from the delivery.
 */
export const transcriptionProfile = defineScratchProfile({
  id: TRANSCRIPTION_PROFILE_ID,
  label: "Transcription",
  description:
    "Sonata transcription: sheet music in a video, images or a PDF → MusicXML, by a render-and-compare loop with the `st` toolkit.",
  inputSchema: ProfileInputSchema,
  instructions: transcriptionInstructions,
  mcpTools: [SUBMIT_TOOL, "flag_raise"],
  permissions: { allow: ["Bash", "Read", "Write", "Edit"] },
  prepare: async ({ dir, input, signal }) => {
    const ready = await awaitDepReady(transcriptionDep, signal);
    const st = join(dir, "bin/st");
    await mkdir(dirname(st), { recursive: true });
    await writeFile(st, stWrapper(join(ready.dir, "bin/python")));
    await chmod(st, 0o755);
    if (input.source.kind !== "url") await copyInputs(dir, input.source.files);
  },
});
