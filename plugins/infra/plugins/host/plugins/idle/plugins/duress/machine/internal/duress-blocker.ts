import {
  duressLatchDir,
  readDuress,
} from "@plugins/infra/plugins/host/plugins/duress/plugins/latch/server";
import {
  defineFileWatcher,
  type FileWatcher,
} from "@plugins/infra/plugins/file-watcher/server";
import { isHostSingleton } from "@plugins/infra/plugins/paths/core";
import {
  IdleBlocker,
  requestIdleEvaluation,
} from "@plugins/infra/plugins/host/plugins/idle/server";
import { duressBlockerReading } from "./reading";

export const duressIdleBlocker = IdleBlocker({
  id: "duress",
  read: async () => duressBlockerReading(await readDuress(), Date.now()),
});

export const duressLatchWatcher = defineFileWatcher({
  name: "host-idle.duress-latch",
  description:
    "Watches the host duress latch, so the idle signal re-checks when the machine goes into or out of duress.",
  extensions: [".latch"],
});

let watcher: FileWatcher | null = null;
// Whether the latch was fresh at the last change heard: the sentinel bumps the
// latch's mtime every tick while tripped, and only a flip is news to the idle
// signal (a lapse with no event is the reading's recheck).
let lastFresh: boolean | null = null;

async function onLatchChange(): Promise<void> {
  const fresh = (await readDuress())?.fresh === true;
  if (fresh === lastFresh) return;
  lastFresh = fresh;
  await requestIdleEvaluation();
}

/** Main only: the one evaluator's input. */
export async function startDuressWatch(): Promise<void> {
  if (!isHostSingleton() || watcher) return;
  const dir = await duressLatchDir.ensure();
  watcher = await duressLatchWatcher.start({
    dirs: [dir],
    onChange: onLatchChange,
    onLost: onLatchChange,
  });
}

export async function stopDuressWatch(): Promise<void> {
  if (!watcher) return;
  await watcher.stop();
  watcher = null;
}
