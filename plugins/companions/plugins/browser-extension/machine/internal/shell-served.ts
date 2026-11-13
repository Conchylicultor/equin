import { mkdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readFile, exists } from "@plugins/packages/plugins/timed-fs/core";
import { defineFileWatcher } from "@plugins/infra/plugins/file-watcher/server";
import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { serveValue } from "@plugins/network/plugins/live/machine";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import {
  browserExtensionConnection,
  browserExtensionShell,
  ConnectionStateSchema,
  recordExtensionOpen,
  type ConnectionState,
  type ShellState,
} from "../../core";
import {
  browserExtensionRoot,
  CONNECTION_FILE,
  SHELL_DIGEST_FILE,
  SHELL_FOLDER,
} from "../../data-dirs";

/** Open only while a tab reads the shell or its connection. */
export const browserExtensionWatcher = defineFileWatcher({
  name: "companions.browser-extension",
  description:
    "While a tab reads the browser extension's state, follows its shell digest (rewritten by a build) and its connection record (written when the popup opens), so a popup reloads onto a new shell and Settings shows the connection at once.",
  // Two known files, followed on kqueue (heard as written).
  writesWhileOpen: true,
});

function root(): string {
  return browserExtensionRoot(runtimeNamespace());
}

async function readShell(): Promise<ShellState> {
  const path = join(root(), SHELL_FOLDER);
  const digestFile = join(root(), SHELL_DIGEST_FILE);
  if (!(await exists(digestFile))) return { kind: "absent", path };
  const digest = (await readFile(digestFile, "utf8")).trim();
  if (digest === "") throw new Error(`${digestFile} is empty`);
  return { kind: "built", path, digest };
}

async function readConnection(): Promise<ConnectionState> {
  const file = join(root(), CONNECTION_FILE);
  if (!(await exists(file))) return { kind: "never" };
  return ConnectionStateSchema.parse(JSON.parse(await readFile(file, "utf8")));
}

/** Follow one of the root's files while subscribed; returns the stop. */
async function follow(file: string, changed: () => void): Promise<() => void> {
  // Following a file in a missing directory fails; creating it is free.
  await mkdir(root(), { recursive: true });
  const watcher = await browserExtensionWatcher.start({
    files: [join(root(), file)],
    label: file,
    onChange: () => changed(),
  });
  return () => {
    void runTracked("browser-extension:watcher-stop", () => watcher.stop());
  };
}

// Push, never a poll: a build rewriting the shell writes its digest file last,
// and the watch hears it; the popup's own open notifies directly.
export const shellServed = serveValue(browserExtensionShell, {
  source: "external",
  changes: "notified",
  loader: readShell,
  whileSubscribed: async (_params, notify) => follow(SHELL_DIGEST_FILE, notify),
});

export const connectionServed = serveValue(browserExtensionConnection, {
  source: "external",
  changes: "notified",
  loader: readConnection,
  whileSubscribed: async (_params, notify) => follow(CONNECTION_FILE, notify),
});

export const handleRecordOpen = implementMachine(
  recordExtensionOpen,
  async ({ body }) => {
    const record: ConnectionState = {
      kind: "seen",
      seenAt: Date.now(),
      shellDigest: body.shellDigest,
    };
    await mkdir(root(), { recursive: true });
    const file = join(root(), CONNECTION_FILE);
    const staged = `${file}.${randomUUID()}`;
    await writeFile(staged, JSON.stringify(record));
    await rename(staged, file);
    connectionServed.notify();
  },
);
