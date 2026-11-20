import { useEffect, useState } from "react";
import { webLocks } from "@plugins/primitives/plugins/dom/plugins/web-locks/core";

// A tab is present while some page holding its id is alive. Each page holds a
// SHARED Web Lock named for its tab id for its whole life, so the browser
// itself keeps the answer — released when the page closes, reloads or is
// killed, whatever it was doing — and any page of the origin can read it
// (`navigator.locks.query()` lists every held and pending lock of the origin's
// storage partition: tabs, app windows, the menu-bar panel alike). Shared, not
// exclusive: a duplicated tab copies its session storage, id included, and
// both copies are that tab.
const LOCK_PREFIX = "equin.tab-presence:";

let claimed = false;

/** Hold this page's presence lock for its lifetime. Idempotent. */
export function claimTabPresence(tabId: string): void {
  if (claimed) return;
  claimed = true;
  const lockHere = webLocks();
  if (lockHere.kind === "unsupported") return;
  // Never resolves: the lock is released by the page going away.
  void lockHere.locks.request(
    LOCK_PREFIX + tabId,
    { mode: "shared" },
    () => new Promise<never>(() => {}),
  );
}

/**
 * Whether a tab is still open, as of when the caller mounted: `open` (some
 * page of the origin holds or is acquiring its presence lock), `closed`, or
 * `unknown` (no Web Locks here, or the tab predates presence). `loading`
 * until the browser answers.
 */
export type TabPresence = "loading" | "open" | "closed" | "unknown";

export function useTabPresence(tabId: string | null): TabPresence {
  const [answer, setAnswer] = useState<{
    tabId: string;
    presence: Exclude<TabPresence, "loading">;
  } | null>(null);
  useEffect(() => {
    const lockHere = webLocks();
    if (tabId === null || lockHere.kind === "unsupported") return;
    let live = true;
    const name = LOCK_PREFIX + tabId;
    void lockHere.locks.query().then((snapshot) => {
      if (!live) return;
      const held = [...(snapshot.held ?? []), ...(snapshot.pending ?? [])];
      setAnswer({
        tabId,
        presence: held.some((l) => l.name === name) ? "open" : "closed",
      });
    });
    return () => {
      live = false;
    };
  }, [tabId]);
  if (tabId === null || webLocks().kind === "unsupported") return "unknown";
  return answer?.tabId === tabId ? answer.presence : "loading";
}
