// Which text blocks render a LIVE Lexical editor; every other text block is a
// dormant line drawn as static text (`StaticBlockText`).
//
// A page shows hundreds of lines and the user edits one. A live editor costs a
// Lexical instance (whose every update reads the DOM selection), a Yjs binding,
// the block-text plugins and ~28 elements — paid per block, on screen or not, it
// made opening a 600-line page a 1–2 s freeze. So a block is live only while
// something needs it to be (research/2026-11-15-page-lazy-block-editors.md):
//
// - it was WOKEN — an edit intent targeted it: a click in its text, a caret
//   landing (arrow, merge, undo, a new block's flight). The few most recently
//   woken stay live (`MAX_RECENT`), so moving back and forth between nearby
//   lines does not remount each time;
// - it is PINNED — the caret's block, a text span's two ends: whatever holds
//   state the static rendering cannot (a caret, a selection being edited).
//
// The set is one external store, read per block (`useIsLiveTextBlock`), so a
// wake or an eviction re-renders exactly the blocks whose answer changed.

/** How many woken blocks stay live beyond the pinned ones. */
export const MAX_RECENT = 8;

type Listener = () => void;

export interface LiveTextEditors {
  isLive: (id: string) => boolean;
  /** Make `id` live now (and the most recently used). Idempotent. */
  wake: (id: string) => void;
  /**
   * Replace the pin set named `key` with `ids`. A pinned block is live
   * whatever the recency set holds; unpinned, it joins the recency set as its
   * most recent member, so it does not drop back to static the moment the
   * caret leaves it.
   */
  pin: (key: string, ids: readonly string[]) => void;
  subscribe: (id: string, listener: Listener) => () => void;
}

export function createLiveTextEditors(): LiveTextEditors {
  /** Recency order, oldest first. */
  const recent: string[] = [];
  const pins = new Map<string, readonly string[]>();
  const listeners = new Map<string, Set<Listener>>();

  const isPinned = (id: string): boolean => {
    for (const ids of pins.values()) if (ids.includes(id)) return true;
    return false;
  };
  const isLive = (id: string): boolean => recent.includes(id) || isPinned(id);

  function notify(ids: Iterable<string>): void {
    for (const id of ids) listeners.get(id)?.forEach((l) => l());
  }

  /** Move `id` to the recent end; evict the oldest unpinned past the cap. */
  function touch(id: string, changed: Set<string>): void {
    const at = recent.indexOf(id);
    if (at >= 0) recent.splice(at, 1);
    recent.push(id);
    let unpinned = recent.filter((r) => !isPinned(r)).length;
    for (let i = 0; i < recent.length && unpinned > MAX_RECENT;) {
      const r = recent[i]!;
      if (isPinned(r) || r === id) {
        i++;
        continue;
      }
      recent.splice(i, 1);
      unpinned--;
      changed.add(r);
    }
  }

  return {
    isLive,
    wake(id) {
      const was = isLive(id);
      const changed = new Set<string>();
      touch(id, changed);
      if (!was) changed.add(id);
      notify(changed);
    },
    pin(key, ids) {
      const before = pins.get(key) ?? [];
      const wasLive = new Map(
        [...before, ...ids].map((id) => [id, isLive(id)]),
      );
      if (ids.length === 0) pins.delete(key);
      else pins.set(key, [...ids]);
      const changed = new Set<string>();
      // A released pin keeps its block live as the most recent woken one.
      for (const id of before) if (!ids.includes(id)) touch(id, changed);
      for (const [id, was] of wasLive) if (isLive(id) !== was) changed.add(id);
      notify(changed);
    },
    subscribe(id, listener) {
      let set = listeners.get(id);
      if (!set) listeners.set(id, (set = new Set()));
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(id);
      };
    },
  };
}
