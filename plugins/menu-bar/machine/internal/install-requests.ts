import type { InstallRequest } from "../../core";

/**
 * The installs the endpoint accepted but has not finished: waiting for the
 * native helper's build, or failed. In memory — a request is the answer to a
 * click on this backend, and a restart asks again.
 */
const requests = new Map<string, InstallRequest>();
const listeners = new Set<() => void>();

function changed(): void {
  for (const l of listeners) l();
}

export const installRequests = {
  list(): InstallRequest[] {
    return [...requests.values()].sort((a, b) =>
      a.appId.localeCompare(b.appId),
    );
  },
  waiting(): string[] {
    return this.list()
      .filter((r) => r.state === "waiting-for-helper")
      .map((r) => r.appId);
  },
  set(request: InstallRequest): void {
    requests.set(request.appId, request);
    changed();
  },
  clear(appId: string): void {
    if (requests.delete(appId)) changed();
  },
  /** Called on every change (the served value's notify). */
  onChange(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
