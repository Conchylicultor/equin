// ── Page inputs: values the page around a browser host hands it ──────────────
//
// A browser host's own code never reads the page's server (the demo's rule 1).
// Some facts it needs are the PAGE's, though — the Maps browser key the real
// app already sends that page. The page's chrome (outside the host's scope)
// reads such a value from its own server and hands it over the port, declared
// by the plugin that owns the value (`browser-server/web`'s
// `HostInputs.Supply`). The host keeps it in memory only: never in its
// storage, so never in a build-time snapshot (taken with no page at all).

/** What a page hands for one input: its value, or why its own read failed. */
export type PageInputValue =
  { kind: "value"; value: unknown } | { kind: "failed"; message: string };

/**
 * One input as the host reads it: no page that connected (to this host, so
 * far) declared it, or its value. Declarations only grow — a page that goes
 * away leaves its last value standing — which fits a host one owner's pages
 * share (the demo); per-page tracking is for a host that needs it.
 */
export type PageInputRead =
  { kind: "absent" } | { kind: "value"; value: unknown };

/** An input of this host, by key — what a host provider reads. */
export interface PageInput {
  /**
   * `absent` when no page that connected declared it; else its latest value,
   * waiting for the first one (a page supplies it once its own read lands —
   * so nothing a host's boot awaits may read one). A page's failed read
   * rejects.
   */
  read(): Promise<PageInputRead>;
  /** `changed` on every new value (or a page declaring it); returns the stop. */
  watch(changed: () => void): () => void;
}

const supplied = new Set<string>();
const latest = new Map<string, PageInputValue>();
const listeners = new Map<string, Set<() => void>>();

function notify(key: string): void {
  for (const listener of [...(listeners.get(key) ?? [])]) listener();
}

/** A page connected supplying `keys` (`portBrowserServer`'s `inputs`). */
export function declarePageInputs(keys: readonly string[]): void {
  for (const key of keys) {
    if (supplied.has(key)) continue;
    supplied.add(key);
    notify(key);
  }
}

/** A page handed `input` for `key`: the newest wins, whichever tab sent it. */
export function receivePageInput(key: string, input: PageInputValue): void {
  if (!supplied.has(key)) {
    throw new Error(
      `[browser-server] page input "${key}" arrived from a page that did not declare it`,
    );
  }
  latest.set(key, input);
  notify(key);
}

export function pageInput(key: string): PageInput {
  const watch = (changed: () => void): (() => void) => {
    let set = listeners.get(key);
    if (set === undefined) listeners.set(key, (set = new Set()));
    set.add(changed);
    return () => set.delete(changed);
  };
  return {
    watch,
    read() {
      if (!supplied.has(key)) return Promise.resolve({ kind: "absent" });
      return new Promise<PageInputRead>((resolve, reject) => {
        const settle = (): boolean => {
          const input = latest.get(key);
          if (input === undefined) return false;
          if (input.kind === "failed") {
            reject(
              new Error(`The page could not read "${key}": ${input.message}`),
            );
          } else {
            resolve({ kind: "value", value: input.value });
          }
          return true;
        };
        if (settle()) return;
        const stop = watch(() => {
          if (settle()) stop();
        });
      });
    },
  };
}
