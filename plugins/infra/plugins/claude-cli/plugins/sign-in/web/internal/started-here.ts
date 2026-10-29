// The sign-ins THIS page started. The flow is the computer's — every tab reads
// it — but only the tab whose click started a run opens its sign-in page and
// says when it finished: one browser tab per click, one toast. Page-global on
// purpose (a page is one browser tab, however many surfaces it mounts), and
// read only from effects, never rendered.

const started = new Set<string>();
const opened = new Set<string>();
const announced = new Set<string>();

export function markStartedHere(id: string): void {
  started.add(id);
}

export function wasStartedHere(id: string): boolean {
  return started.has(id);
}

/** True the first time it is asked for `id` (its page is opened once). */
export function claimOpen(id: string): boolean {
  if (opened.has(id)) return false;
  opened.add(id);
  return true;
}

/** True the first time it is asked for `id` (its outcome is announced once). */
export function claimAnnouncement(id: string): boolean {
  if (announced.has(id)) return false;
  announced.add(id);
  return true;
}
