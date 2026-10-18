import { readdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  defineFileWatcher,
  type FileWatcher,
} from "@plugins/infra/plugins/file-watcher/server";
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { createCoalescer } from "@plugins/packages/plugins/coalesce/core";
import { recordReport } from "@plugins/reports/server";
import { promptSubmitsDir } from "../../data-dirs";
import { resolvePromptSubmit } from "./store";

// The CLI → server channel for "I submitted this prompt": a file per
// `UserPromptSubmit` hook run, not a network call.
//   - it costs the hook milliseconds and can never block a submission;
//   - it survives a backend restart — the file waits, and the boot drain
//     resolves the turn it confirms;
//   - its command is plain shell over a path held to a safe alphabet.
//
// The hook writes `<dir>/<namespace>/<conversationId>.<epoch>.<pid>.json`
// (write to `.tmp`, then rename, so a reader never sees half a file). Each
// backend watches only `<dir>/<its own namespace>/` — the namespace a pane was
// launched from is the backend whose database holds the conversation.

// The command crosses two shells (the pane's single-quoted `--settings`, then
// the CLI's hook shell), so the path is held to a plain-path alphabet rather
// than escaped for both.
const SAFE_PATH_RE = /^\/[A-Za-z0-9_./ +-]+$/;

export interface PromptSubmitHookEntry {
  type: "command";
  command: string;
}

/**
 * The hook command, for a mailbox rooted at `dir`. It must always exit 0 and
 * print nothing — a UserPromptSubmit hook's stdout becomes model context, and a
 * failing one surfaces in the agent's terminal. `$SINGULARITY_PARENT_HOST` and
 * `$SINGULARITY_CONVERSATION_ID` are delivered to the pane (runtime-tmux's
 * agent-session-env.ts).
 */
export function promptSubmitHookCommand(dir: string): string {
  if (!SAFE_PATH_RE.test(dir)) {
    throw new Error(
      `prompt-submit mailbox ${JSON.stringify(dir)} must be absolute and plain ` +
        `(it is spliced into a hook command)`,
    );
  }
  return [
    `d="${dir}/$SINGULARITY_PARENT_HOST"`,
    `f="$d/$SINGULARITY_CONVERSATION_ID.$(date +%s).$$"`,
    `{ mkdir -p "$d" && cat > "$f.tmp" && mv "$f.tmp" "$f.json"; } >/dev/null 2>&1`,
    "exit 0",
  ].join("; ");
}

/** The UserPromptSubmit hook entry an agent launch merges into its settings. */
export function promptSubmitHookEntry(): PromptSubmitHookEntry {
  return {
    type: "command",
    command: promptSubmitHookCommand(promptSubmitsDir.ensure()),
  };
}

export const promptSubmitsWatcher = defineFileWatcher({
  name: "turn-ledger.prompt-submits",
  description:
    "Watches the prompt-submit mailbox, where each agent's UserPromptSubmit hook drops the prompt the CLI just submitted, and confirms the matching turn in the turn ledger.",
  extensions: [".json"],
  debounceMs: 25,
});

/** The hook's stdin, of which only the prompt is read. */
const PromptSubmitPayloadSchema = z.object({ prompt: z.string() });

/** `<conversationId>.<epoch>.<pid>.json` → the conversation id, or null. */
export function conversationOfMailboxFile(name: string): string | null {
  const match = /^([A-Za-z0-9_-]+)\.\d+\.\d+\.json$/.exec(name);
  return match ? match[1]! : null;
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

async function removeFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
}

/**
 * Resolve every file in the mailbox, oldest first, deleting each once its turn
 * is resolved. A file that does not parse is reported and deleted: it would
 * otherwise fail every later drain.
 */
async function drainMailbox(dir: string): Promise<void> {
  const files: { path: string; conversationId: string; mtimeMs: number }[] = [];
  for (const name of await readdir(dir)) {
    const conversationId = conversationOfMailboxFile(name);
    if (!conversationId) continue;
    const path = join(dir, name);
    try {
      files.push({ path, conversationId, mtimeMs: (await stat(path)).mtimeMs });
    } catch (err) {
      if (!isEnoent(err)) throw err;
    }
  }
  files.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));

  for (const file of files) {
    let raw: string;
    try {
      raw = await readFile(file.path, "utf8");
    } catch (err) {
      if (isEnoent(err)) continue;
      throw err;
    }
    let prompt: string;
    try {
      prompt = PromptSubmitPayloadSchema.parse(JSON.parse(raw)).prompt;
    } catch (err) {
      if (!(err instanceof SyntaxError || err instanceof z.ZodError)) throw err;
      await recordReport({
        kind: "crash",
        source: "server-caught",
        message: `turn-ledger: unreadable prompt-submit file ${file.path}: ${err.message}`,
        data: {
          errorType: "PromptSubmitParseError",
          label: "turn-ledger.prompt-submits",
        },
      });
      await removeFile(file.path);
      continue;
    }
    await resolvePromptSubmit(
      file.conversationId,
      prompt,
      new Date(file.mtimeMs),
    );
    await removeFile(file.path);
  }
}

let started = false;

/**
 * Open this backend's mailbox: drain what is already there (files written while
 * no backend was up), then resolve every new file as it lands. One drain runs at
 * a time; changes landing mid-drain fold into one more.
 */
export async function startPromptSubmitMailbox(): Promise<() => Promise<void>> {
  if (started) throw new Error("turn-ledger mailbox: already started");
  started = true;
  const dir = promptSubmitsDir.subdir(runtimeNamespace()).ensure();
  const drain = createCoalescer({ run: () => drainMailbox(dir) });
  let watcher: FileWatcher;
  try {
    watcher = await promptSubmitsWatcher.start({
      dirs: [dir],
      onChange: () => drain.run([]),
    });
  } catch (err) {
    started = false;
    throw err;
  }
  await drain.run([]);
  return async () => {
    started = false;
    await watcher.stop();
  };
}
