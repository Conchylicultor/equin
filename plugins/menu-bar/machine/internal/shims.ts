import { readyNow, type Ready } from "@plugins/infra/plugins/deps/deps";
import {
  onDepInstallSettled,
  requestDep,
} from "@plugins/infra/plugins/deps/server";
import {
  cargoBinary,
  type CargoSource,
} from "@plugins/infra/plugins/deps/plugins/rust/deps";
import { HttpError } from "@plugins/infra/plugins/endpoints/core";
import { createKeyedMutex } from "@plugins/packages/plugins/keyed-mutex/core";
import { menuBarHelper } from "../../deps";
import { menuBarState } from "../../data-dirs";
import { pinRequests } from "./pin-requests";
import {
  machineCapabilities,
  machineShimHost,
  shimApp,
  shimApps,
} from "./machine-host";
import type { ShimApp } from "./shim-files";
import {
  pinShim,
  syncShims,
  syncStableHelper,
  writeShim,
  readInstalledShims,
  type ShimHost,
} from "./shim-host";
import { installedServed, pinnedServed } from "./values";

// Every write to the shims and the stable helper runs one at a time: a pin
// and a sync both write shims from the same helper copy.
const shimMutex = createKeyedMutex();
const SHIMS = "shims";

/**
 * Bring the stable helper to `ready`'s identity. `changed`: it was replaced,
 * so every shim (a clone of the old binary on macOS) is stale.
 */
function syncHelper(ready: Ready<CargoSource>) {
  return syncStableHelper(
    menuBarState.path,
    cargoBinary(ready),
    ready.identity,
  );
}

/**
 * Every installable app gets its shim, ahead of any click — so a menu-bar
 * tile always opens its app's own window, instantly: missing or stale shims
 * written, renamed or removed apps' shims removed (`syncShims`). Run by main
 * (it owns the stable helper) on boot and whenever a helper build settles;
 * only once the helper is built — it never requests the build (no helper, no
 * tray, no panel to open from).
 */
export async function syncAllShimsOnMain(): Promise<void> {
  const caps = await machineCapabilities();
  const host = machineShimHost();
  if (!caps.install || host === null) return;
  const now = await readyNow(menuBarHelper);
  if (now.kind !== "ready") return;
  await shimMutex.run(SHIMS, async () => {
    const helper = syncHelper(now.ready);
    await syncShims(host, helper.binary, shimApps(), {
      rewriteAll: helper.changed,
    });
  });
  installedServed.notify();
  pinnedServed.notify();
}

async function pinNow(
  host: ShimHost,
  ready: Ready<CargoSource>,
  app: ShimApp,
): Promise<void> {
  await shimMutex.run(SHIMS, async () => {
    const helper = syncHelper(ready);
    const installed = readInstalledShims(host).map((s) => s.appId);
    // A new helper binary: every shim this host knows is a clone of the old
    // one. (Only rewritten, never removed — the app set to prune against is
    // main's, which its own sync applies.)
    const rewrite = helper.changed ? installed : [];
    // Main's sync has normally written this one already; a worktree (or a pin
    // racing main's first sync) writes it here.
    if (!installed.includes(app.id)) rewrite.push(app.id);
    for (const id of new Set(rewrite)) {
      const target = id === app.id ? app : shimApp(id);
      if (target !== undefined) await writeShim(host, target, helper.binary);
    }
    await pinShim(host, app);
  });
  pinRequests.clear(app.id);
  installedServed.notify();
  pinnedServed.notify();
}

let waitingForHelper = false;

/**
 * Resume the pins waiting on the helper once its build settles (pushed by
 * the deps install job — no polling). Ready → every waiting app is pinned;
 * failed → each is marked failed with the build's message; still installing
 * (another request's run) → keep waiting for the next settle.
 */
function awaitHelper(host: ShimHost): void {
  if (waitingForHelper) return;
  waitingForHelper = true;
  const off = onDepInstallSettled(menuBarHelper, () => {
    void (async () => {
      const now = await readyNow(menuBarHelper);
      if (now.kind === "installing" || now.kind === "absent") return;
      off();
      waitingForHelper = false;
      for (const appId of pinRequests.waiting()) {
        const app = shimApp(appId);
        if (now.kind === "failed" || app === undefined) {
          pinRequests.set({
            appId,
            state: "failed",
            message:
              now.kind === "failed"
                ? `Building the native helper failed: ${now.message}`
                : `"${appId}" is no longer an installable app.`,
          });
          continue;
        }
        await pinNow(host, now.ready, app).catch((err: unknown) => {
          // The click that asked has returned already: the failure is the
          // request's state, shown on the tile.
          pinRequests.set({
            appId,
            state: "failed",
            message: err instanceof Error ? err.message : String(err),
          });
        });
      }
    })();
  });
}

/**
 * The pin endpoint's body: refuse what this host or app cannot do; with the
 * helper built, make sure the shim is there and pin it now; otherwise request
 * the helper's build and record the app as waiting for it.
 */
export async function pinApp(
  appId: string,
): Promise<{ status: "pinned" | "waiting-for-helper" }> {
  const caps = await machineCapabilities();
  const host = machineShimHost();
  if (!caps.pin || host === null) {
    throw new HttpError(
      409,
      caps.reason ?? "Pinning apps is not supported here.",
    );
  }
  const app = shimApp(appId);
  if (app === undefined) {
    throw new HttpError(404, `"${appId}" is not an installable app.`);
  }
  const now = await readyNow(menuBarHelper);
  if (now.kind === "ready") {
    await pinNow(host, now.ready, app);
    return { status: "pinned" };
  }
  pinRequests.set({ appId, state: "waiting-for-helper" });
  // Subscribed before the request, so a run that settles at once is heard.
  awaitHelper(host);
  await requestDep(menuBarHelper);
  return { status: "waiting-for-helper" };
}
