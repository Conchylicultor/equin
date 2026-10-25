import { existsSync } from "node:fs";
import {
  rcodesign,
  type RcodesignTool,
} from "@plugins/infra/plugins/codesign/deps";
import {
  readyNow,
  type Dep,
  type DepSource,
  type Ready,
} from "@plugins/infra/plugins/deps/deps";
import {
  onDepInstallSettled,
  requestDep,
} from "@plugins/infra/plugins/deps/server";
import { createKeyedMutex } from "@plugins/packages/plugins/keyed-mutex/core";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";
import { loginServiceId, type LoginServiceDeclaration } from "./define";
import { loginServiceManager } from "./host";
import type { LoginService } from "./login-service";
import { machineMacosAppHost, macosAppToolDeps } from "./macos-app";
import { reconcileLoginService, type ReconcileOutcome } from "./reconcile";
import { declaredLoginServices } from "./registry";

// One reconcile per service at a time: a build settling while the boot
// reconcile of the same service runs must not reload it twice.
const serviceMutex = createKeyedMutex();

const followLog = defineLogSink({
  id: "login-services",
  description:
    "Login services following main: each declared service's dependency requested, and each reload or definition rewrite onto main's build.",
});

/**
 * Main's boot: bring every declared login service the user `start`ed to the
 * dependency main's checkout now builds — so a push changing a service's
 * binary reaches it without anyone running `./equin start`. Names no service.
 *
 * No watcher: main's checkout moves only on a push, and every push restarts
 * main's backend (its auto-build), which runs this. A dependency not built at
 * main's identity yet is requested through `deps` (built off the boot path, in
 * the `deps.install` job) and reconciled when that settles; the old service
 * keeps running meanwhile.
 */
export async function followMain(): Promise<void> {
  const manager = loginServiceManager();
  if (manager === null) return;
  for (const decl of await declaredLoginServices()) {
    const service = manager.service(loginServiceId(decl));
    // Opt-in: only what a `start` registered follows main. Checked again
    // inside the reconcile, which owns the rule; here it spares an identity
    // hash for every service nobody started.
    if (!existsSync(service.definitionPath())) continue;
    await followOne(service, decl);
  }
}

async function followOne<S extends DepSource>(
  service: LoginService,
  decl: LoginServiceDeclaration<S>,
): Promise<void> {
  if (await reconcileIfBuilt(service, decl)) return;
  // Every dependency the reconcile waits for: the service's own build, and
  // what installing it into the macOS app needs (a backend may not install
  // anything on its event loop, so it waits through `deps` like the build).
  const waitedFor: Dep[] = [decl.dep, ...macosAppToolDeps(process.platform)];
  // Subscribed before the requests, so a run that settles at once is heard.
  const offs = waitedFor.map((dep) =>
    onDepInstallSettled(dep, () => {
      // A settle that leaves something still unbuilt (another dependency, or
      // another request's run) keeps waiting for the next; ready reconciles,
      // failed throws — both stop.
      void reconcileIfBuilt(service, decl).then(
        (settled) => {
          if (settled) offAll();
        },
        (err: unknown) => {
          offAll();
          throw err;
        },
      );
    }),
  );
  const offAll = () => {
    for (const off of offs) off();
  };
  followLog.publish(
    `${decl.id}: ${waitedFor.map((d) => d.id).join(", ")} not all built at main's identity yet; requested their install`,
  );
  for (const dep of waitedFor) await requestDep(dep);
}

/**
 * Reconcile `decl` under `follow` when main's build of its dependency — and
 * every tool installing into the macOS app needs — is installed; whether it
 * was (false: one is absent or installing — wait for a settle). A failed
 * build throws: the service keeps its old binary, and the failure is loud
 * rather than a service that silently never follows main again.
 */
async function reconcileIfBuilt<S extends DepSource>(
  service: LoginService,
  decl: LoginServiceDeclaration<S>,
): Promise<boolean> {
  return serviceMutex.run(decl.id, async () => {
    const now = await builtNow(decl, decl.dep);
    if (now === null) return false;
    let tool: RcodesignTool | null = null;
    if (macosAppToolDeps(process.platform).includes(rcodesign)) {
      const installed = await builtNow(decl, rcodesign);
      if (installed === null) return false;
      tool = { installed };
    }
    const log = (line: string) =>
      followLog.publish(`${decl.id} (${decl.owner}): ${line}`);
    const outcome = await reconcileLoginService(service, decl, now, "follow", {
      // Off macOS nothing is installed, so nothing asks for the tool.
      host: machineMacosAppHost(tool, log),
      log,
    });
    const line = describeFollow(outcome);
    if (line !== null) log(line);
    return true;
  });
}

/** `dep`'s build at main's identity, null while absent / installing; a failed build throws. */
async function builtNow<S extends DepSource>(
  decl: LoginServiceDeclaration,
  dep: Dep<S>,
): Promise<Ready<S> | null> {
  const now = await readyNow(dep);
  if (now.kind === "absent" || now.kind === "installing") return null;
  if (now.kind === "failed") {
    throw new Error(
      `${decl.id} (${decl.owner}) cannot follow main: building ${dep.id} failed (${now.message}). It keeps running its previous binary.`,
    );
  }
  return now.ready;
}

function describeFollow(outcome: ReconcileOutcome): string | null {
  switch (outcome.kind) {
    case "unregistered":
    case "unchanged":
      return null;
    case "rewritten":
      return `stopped; its definition now names main's build (${outcome.path})`;
    case "started":
      return `reloaded onto main's build (PID ${outcome.pid})`;
  }
}
