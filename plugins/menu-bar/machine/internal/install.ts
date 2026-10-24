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
import { installRequests } from "./install-requests";
import { machineCapabilities, machineShimHost, shimApp } from "./machine-host";
import type { ShimApp } from "./shim-files";
import {
  hasStableHelper,
  pinShim,
  reconcileShims,
  syncStableHelper,
  writeShim,
  type ShimHost,
} from "./shim-host";
import { installedServed } from "./values";

// Every write to the shims and the stable helper runs one at a time: an
// install and a reconcile both rewrite shims from the same helper copy.
const shimMutex = createKeyedMutex();
const SHIMS = "shims";

/**
 * Bring the stable helper to `ready`'s identity, and — when that replaced it —
 * rewrite every installed shim against the new binary. Returns the stable
 * binary's path.
 */
async function syncHelper(
  host: ShimHost,
  ready: Ready<CargoSource>,
): Promise<string> {
  const stable = syncStableHelper(
    menuBarState.path,
    cargoBinary(ready),
    ready.identity,
  );
  if (stable.changed) await reconcileShims(host, stable.binary, shimApp);
  return stable.binary;
}

async function installNow(
  host: ShimHost,
  ready: Ready<CargoSource>,
  app: ShimApp,
): Promise<void> {
  const caps = await machineCapabilities();
  await shimMutex.run(SHIMS, async () => {
    const helper = await syncHelper(host, ready);
    await writeShim(host, app, helper);
    if (caps.pin) await pinShim(host, app);
  });
  installRequests.clear(app.id);
  installedServed.notify();
}

let waitingForHelper = false;

/**
 * Resume the installs waiting on the helper once its build settles (pushed by
 * the deps install job — no polling). Ready → every waiting app is installed;
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
      for (const appId of installRequests.waiting()) {
        const app = shimApp(appId);
        if (now.kind === "failed" || app === undefined) {
          installRequests.set({
            appId,
            state: "failed",
            message:
              now.kind === "failed"
                ? `Building the native helper failed: ${now.message}`
                : `"${appId}" is no longer an installable app.`,
          });
          continue;
        }
        await installNow(host, now.ready, app).catch((err: unknown) => {
          // The click that asked has returned already: the failure is the
          // request's state, shown on the tile.
          installRequests.set({
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
 * The install endpoint's body: refuse what this host or app cannot do; with
 * the helper built, write the shim (and pin it) now; otherwise request the
 * helper's build and record the app as waiting for it.
 */
export async function installApp(
  appId: string,
): Promise<{ status: "installed" | "waiting-for-helper" }> {
  const caps = await machineCapabilities();
  const host = machineShimHost();
  if (!caps.install || host === null) {
    throw new HttpError(
      409,
      caps.reason ?? "Installing apps is not supported here.",
    );
  }
  const app = shimApp(appId);
  if (app === undefined) {
    throw new HttpError(404, `"${appId}" is not an installable app.`);
  }
  const now = await readyNow(menuBarHelper);
  if (now.kind === "ready") {
    await installNow(host, now.ready, app);
    return { status: "installed" };
  }
  installRequests.set({ appId, state: "waiting-for-helper" });
  // Subscribed before the request, so a run that settles at once is heard.
  awaitHelper(host);
  await requestDep(menuBarHelper);
  return { status: "waiting-for-helper" };
}

/**
 * Re-sync the shims to main's helper when its identity moved — on main's
 * boot and whenever a helper build settles there. Only when something was
 * ever installed (a stable copy exists); never builds the helper itself.
 */
export async function reconcileOnMain(): Promise<void> {
  const host = machineShimHost();
  if (host === null || !hasStableHelper(menuBarState.path)) return;
  const now = await readyNow(menuBarHelper);
  if (now.kind !== "ready") return;
  await shimMutex.run(SHIMS, async () => {
    await syncHelper(host, now.ready);
  });
  installedServed.notify();
}
