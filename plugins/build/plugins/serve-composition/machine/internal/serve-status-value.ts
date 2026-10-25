import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { NAMESPACE_LABEL_RE } from "@plugins/infra/plugins/namespace/core";
import { worktreesDir } from "@plugins/infra/plugins/paths/server";
import { isCompositionMarkerPath } from "@plugins/infra/plugins/worktree/server";
import {
  acquireDirWatch,
  type DirWatchRelease,
} from "@plugins/infra/plugins/file-watcher/server";
import { serveValue } from "@plugins/network/plugins/live/machine";
import { serveStatus } from "../../shared/serve-status";
import {
  readServeStatus,
  serveNamespaceOf,
} from "../../server/internal/serve-status";

/**
 * Hear the namespace dir's marker change for as long as the release is held.
 *
 * Two watches, both children-scope through the shared dir hub: one of the
 * worktrees home, filtered to the namespace dir itself (a first serve build
 * creates it, a reclaim removes it), and — while the namespace dir exists —
 * one of the namespace dir, where the serve build lands `composition.json`.
 * The namespace dir is never created here: an empty dir for a composition
 * nothing has served would read, to every other scanner of the worktrees home,
 * as a namespace that exists.
 *
 * The inner watch hears the marker alone (`isCompositionMarkerPath`, from its
 * owner `infra/worktree`): a served namespace dir is a whole worktree data dir
 * whose op markers, logs and status files change several times a minute, none
 * of which moves this answer.
 */
async function watchServeMarker(
  composition: string,
  notify: () => void,
): Promise<DirWatchRelease> {
  const home = worktreesDir();
  mkdirSync(home, { recursive: true });
  const ns = await serveNamespaceOf(composition);
  const nsDir = join(home, ns);
  let inner: DirWatchRelease | null = null;
  let stopped = false;

  const dropInner = () => {
    inner?.();
    inner = null;
  };
  // Re-reads nothing itself: the initial arm precedes the tuple's first load,
  // and the home watch re-reads after arming (below), which closes the gap
  // for a marker that landed before a later-appearing dir's watch opened.
  const armInner = async () => {
    if (inner !== null || !existsSync(nsDir)) return;
    let release: DirWatchRelease;
    try {
      release = await acquireDirWatch({
        dir: nsDir,
        scope: "children",
        onChange: (events) => {
          if (events.some((e) => isCompositionMarkerPath(e.path))) notify();
        },
      });
    } catch (err) {
      // Removed between the check and the open (a reclaim): the home watch
      // hears it come back. Any other failure is real.
      if (!existsSync(nsDir)) return;
      throw err;
    }
    if (stopped || inner !== null) {
      release();
      return;
    }
    inner = release;
  };

  const outer = await acquireDirWatch({
    dir: home,
    scope: "children",
    onChange: async (events) => {
      if (!events.some((e) => basename(e.path) === ns)) return;
      if (existsSync(nsDir)) await armInner();
      else dropInner();
      notify();
    },
  });
  // No trailing re-read: the runtime awaits this start before the tuple's
  // first load, so that load already runs with both watches open.
  await armInner();
  return () => {
    stopped = true;
    outer();
    dropInner();
  };
}

/**
 * `notified`, by a watch on the namespace's marker for as long as a tuple is
 * read. The marker is the whole truth of liveness; `namespace`, `url` and
 * `autoTriggersHere` are facts about this backend's checkout, fixed for its
 * lifetime.
 */
export const serveStatusServed = serveValue(serveStatus, {
  source: "external",
  changes: "notified",
  loader: ({ composition }) => {
    if (!NAMESPACE_LABEL_RE.test(composition)) {
      throw serveStatus.refuse(
        "invalid-composition",
        `not a valid composition id: ${JSON.stringify(composition)}`,
      );
    }
    return readServeStatus(composition);
  },
  // A malformed id watches nothing; the loader refuses it.
  whileSubscribed: ({ composition }, notify) =>
    NAMESPACE_LABEL_RE.test(composition)
      ? watchServeMarker(composition, notify)
      : () => {},
});
