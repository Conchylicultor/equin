// The page's reload readiness, as one module-level store: the holds running
// processes took (`holdReload`), and the engagement / visibility facts the
// gesture watcher feeds in (`setReadinessFacts`). Module scope, not React
// context: a hold is taken by code that renders nothing (an audio engine, the
// send lane, an upload), and there is one page to reload.

/** One running process that would stop if the page reloaded now. */
export interface ReloadHold {
  /**
   * What stops, in the user's words ("Playback", "Upload", "Saving", "Drag") —
   * the reload policy shows it ("Update waits for: Playback"). Several holds
   * may share a label; a reader dedupes them for display.
   */
  readonly label: string;
}

/** Everything the reload policy reads to pick its moment. */
export interface ReloadReadiness {
  /** The processes holding the page; a quiet reload waits until it is empty. */
  readonly holds: readonly ReloadHold[];
  /**
   * The user is mid-interaction: a popup is open, focus is in an editable, a
   * pointer is pressed, or there was input in the last 10 seconds. A reload
   * would interrupt them even when it loses nothing.
   */
  readonly engaged: boolean;
  /** The page is not visible (`document.visibilityState === "hidden"`). */
  readonly hidden: boolean;
}

/** The engagement and visibility facts the gesture watcher maintains. */
export interface ReadinessFacts {
  popupOpen: boolean;
  editableFocused: boolean;
  recentInput: boolean;
  pointerPressed: boolean;
  hidden: boolean;
}

const INITIAL_FACTS: ReadinessFacts = {
  popupOpen: false,
  editableFocused: false,
  recentInput: false,
  pointerPressed: false,
  hidden: false,
};

const holds = new Map<number, ReloadHold>();
let nextHoldId = 0;
let facts: ReadinessFacts = INITIAL_FACTS;
let snapshot: ReloadReadiness = derive();
const listeners = new Set<() => void>();

function derive(): ReloadReadiness {
  return {
    holds: [...holds.values()],
    engaged:
      facts.popupOpen ||
      facts.editableFocused ||
      facts.recentInput ||
      facts.pointerPressed,
    hidden: facts.hidden,
  };
}

function publish(): void {
  const next = derive();
  if (
    next.engaged === snapshot.engaged &&
    next.hidden === snapshot.hidden &&
    next.holds.length === snapshot.holds.length &&
    next.holds.every((h, i) => h === snapshot.holds[i])
  )
    return;
  snapshot = next;
  for (const listener of [...listeners]) listener();
}

/**
 * Hold the page: a running process that a reload would stop (playback, an
 * upload in flight, a write not yet acked, a drag). Returns the release — call
 * it exactly once, when the process ends; a second call throws, since it means
 * two owners think they hold one process.
 *
 * Take holds inside the primitive that runs the process, never at a feature's
 * call site, so no feature can start one without it.
 */
export function holdReload(label: string): () => void {
  const id = nextHoldId++;
  holds.set(id, { label });
  publish();
  return () => {
    if (!holds.delete(id))
      throw new Error(`reload hold "${label}" was released twice`);
    publish();
  };
}

/** Merge new engagement / visibility facts (the gesture watcher's only door). */
export function setReadinessFacts(patch: Partial<ReadinessFacts>): void {
  facts = { ...facts, ...patch };
  publish();
}

/** The current readiness. Stable until something in it changes. */
export function readReloadReadiness(): ReloadReadiness {
  return snapshot;
}

/** Calls `listener` whenever the readiness changes. */
export function subscribeReloadReadiness(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Resolves once no hold is left (at once when there is none). */
export function holdsCleared(): Promise<void> {
  if (holds.size === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = subscribeReloadReadiness(() => {
      if (holds.size > 0) return;
      unsubscribe();
      resolve();
    });
  });
}

/** Back to the initial store, for this plugin's own tests only. */
export function resetReadinessStore(): void {
  holds.clear();
  facts = INITIAL_FACTS;
  snapshot = derive();
}
