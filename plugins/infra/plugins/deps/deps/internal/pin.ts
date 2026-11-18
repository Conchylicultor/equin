import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import type { ExecContext } from "@plugins/infra/plugins/jobs/plugins/supervised-job/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import type { Dep, DepPin, DepSource, Ready, SourceVersion } from "./dep";
import { ensureDep } from "./ensure";
import { heldDep, holdDep } from "./hold";
import { currentIdentity, type DepStore } from "./store";

/**
 * How the pinned install stands against the checkout's current declaration:
 * the same identity, another one (a version a `bun install` brought in that
 * the pin does not follow), or underivable (the checkout cannot say).
 */
export type PinDrift =
  | { kind: "same" }
  | { kind: "differs"; checkout: string }
  | { kind: "failed"; message: string };

/** What {@link pinnedDep} found or made. */
export interface PinnedDep<S extends DepSource> {
  readonly ready: Ready<S>;
  /** True when nothing was pinned yet and this call pinned the checkout's install. */
  readonly adopted: boolean;
  readonly drift: PinDrift;
}

interface PinOptions {
  /** The checkout whose declaration to read. Default: this one. */
  root?: AppPath;
  store?: DepStore;
  log?: (line: string) => void;
}

function pinOf(dep: Dep<DepSource>): DepPin {
  if (dep.pin === null) {
    throw new Error(
      `${dep.id} declares no pin: it runs from the checkout's current install (ensureDep), not a pinned one`,
    );
  }
  return dep.pin;
}

/**
 * The hold that names the install a running daemon was started from — kept
 * apart from the pin, so moving the pin never releases the bytes the live
 * daemon still runs to the sweep. See {@link holdRunningDep}.
 */
function runningHolder(pin: DepPin): string {
  return `${pin.holder}-running`;
}

/**
 * The install `dep` runs from: the one its pin holds — never the checkout's
 * current identity, so no install in a checkout changes what the next start
 * runs. With nothing pinned yet (the first start, or a machine from before the
 * pin), the checkout's install is ensured and pinned: adopting what would have
 * run anyway. `drift` says whether the checkout now declares something else,
 * for the caller to report — moving to it is {@link pinDep}'s, on purpose.
 */
export async function pinnedDep<S extends DepSource>(
  dep: Dep<S>,
  exec: ExecContext,
  opts: PinOptions = {},
): Promise<PinnedDep<S>> {
  const pin = pinOf(dep);
  const root = opts.root ?? REPO_ROOT;
  const held = await heldDep(dep, pin.holder, { store: opts.store });
  if (held.kind === "held") {
    return {
      ready: held.ready,
      adopted: false,
      drift: await driftOf(dep, held.ready.identity, root),
    };
  }
  const ready = await ensureDep(dep, exec, {
    root,
    store: opts.store,
    log: opts.log,
  });
  await holdDep(ready, pin.holder, { store: opts.store });
  return { ready, adopted: true, drift: { kind: "same" } };
}

async function driftOf(
  dep: Dep<DepSource>,
  pinned: string,
  root: AppPath,
): Promise<PinDrift> {
  try {
    const { identity } = await currentIdentity(dep, root);
    return identity === pinned
      ? { kind: "same" }
      : { kind: "differs", checkout: identity };
  } catch (err) {
    return {
      kind: "failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** What {@link pinDep} did. */
export interface PinMove<S extends DepSource> {
  /** The install pinned before, or null when nothing was. */
  readonly from: Ready<S> | null;
  readonly to: Ready<S>;
}

/**
 * Move `dep`'s pin to the checkout's current install (installing it first):
 * the explicit switch. Nothing restarts — the move takes effect at the pin's
 * `appliesAt`. The install the running daemon was started from keeps its own
 * hold ({@link holdRunningDep}), so it stays on disk until the daemon restarts
 * onto the new one.
 */
export async function pinDep<S extends DepSource>(
  dep: Dep<S>,
  exec: ExecContext,
  opts: PinOptions = {},
): Promise<PinMove<S>> {
  const pin = pinOf(dep);
  const root = opts.root ?? REPO_ROOT;
  const before = await heldDep(dep, pin.holder, { store: opts.store });
  // Refused before installing anything: a blocked move (a Postgres major)
  // would only pin bytes the daemon's next start cannot run.
  if (before.kind === "held" && pin.switchBlocked !== undefined) {
    const version = versionOf(dep);
    const [from, to] = await Promise.all([
      version.installed(before.ready.dir),
      version.declared(root),
    ]);
    const blocked = pin.switchBlocked(from, to);
    if (blocked !== null) {
      throw new Error(
        `${dep.id}: not moving the pin from ${from} to ${to} — ${blocked}`,
      );
    }
  }
  const to = await ensureDep(dep, exec, {
    root,
    store: opts.store,
    log: opts.log,
  });
  await holdDep(to, pin.holder, { store: opts.store });
  return { from: before.kind === "held" ? before.ready : null, to };
}

/**
 * Record that a daemon was just started from `ready` (its pinned install): a
 * hold of its own, moved only by the next start, so a pin moved while the
 * daemon runs never hands the bytes under it to the sweep.
 */
export async function holdRunningDep(
  ready: Ready<DepSource>,
  opts: { store?: DepStore } = {},
): Promise<void> {
  await holdDep(ready, runningHolder(pinOf(ready.dep)), opts);
}

function versionOf(dep: Dep<DepSource>): SourceVersion {
  const version = dep.source.version;
  if (version === undefined) {
    throw new Error(
      `${dep.id}: its ${dep.source.kind} source reads no version (DepSource.version)`,
    );
  }
  return version;
}

/** One install of a pinned dependency, as {@link pinStatus} names it. */
export interface PinnedInstall {
  readonly identity: string;
  /** Its version (`DepSource.version`), or null when the source reads none. */
  readonly version: string | null;
}

/**
 * What a checkout declares against the pin: the pinned install itself, another
 * one — `blocked` saying why moving to it is not a plain switch (the pin's
 * `switchBlocked`), null when `./equin deps pin` is the whole move — or
 * underivable (the checkout cannot say).
 */
export type DeclaredAgainstPin =
  | { kind: "same" }
  | { kind: "differs"; install: PinnedInstall; blocked: string | null }
  | { kind: "failed"; message: string };

/**
 * Where a pinned dependency stands, read only (nothing installed, held or
 * moved): nothing pinned yet (the daemon's next fresh start pins the
 * checkout's install), or the pinned install, the one the running daemon was
 * started from when that is another (`running`: a pin moved since, taking
 * effect at the pin's `appliesAt`; null when the same or never recorded), and
 * what the checkout at `root` declares against it.
 */
export type PinStatus =
  | { kind: "unpinned" }
  | {
      kind: "pinned";
      pinned: PinnedInstall;
      running: PinnedInstall | null;
      declared: DeclaredAgainstPin;
    };

/** Where `dep`'s pin stands against the checkout at `root` (see {@link PinStatus}). */
export async function pinStatus(
  dep: Dep<DepSource>,
  opts: { root: AppPath; store?: DepStore },
): Promise<PinStatus> {
  const pin = pinOf(dep);
  const version = dep.source.version;
  const [held, running] = await Promise.all([
    heldDep(dep, pin.holder, { store: opts.store }),
    heldDep(dep, runningHolder(pin), { store: opts.store }),
  ]);
  if (held.kind === "none") return { kind: "unpinned" };
  const pinned: PinnedInstall = {
    identity: held.ready.identity,
    version: (await version?.installed(held.ready.dir)) ?? null,
  };
  const runningInstall =
    running.kind === "held" && running.ready.identity !== pinned.identity
      ? {
          identity: running.ready.identity,
          version: (await version?.installed(running.ready.dir)) ?? null,
        }
      : null;
  let declared: DeclaredAgainstPin;
  try {
    const install = await declaredInstall(dep, opts.root);
    declared =
      install.identity === pinned.identity
        ? { kind: "same" }
        : {
            kind: "differs",
            install,
            blocked:
              pin.switchBlocked !== undefined &&
              pinned.version !== null &&
              install.version !== null
                ? pin.switchBlocked(pinned.version, install.version)
                : null,
          };
  } catch (err) {
    declared = { kind: "failed", message: messageOf(err) };
  }
  return { kind: "pinned", pinned, running: runningInstall, declared };
}

async function declaredInstall(
  dep: Dep<DepSource>,
  root: AppPath,
): Promise<PinnedInstall> {
  const [{ identity }, version] = await Promise.all([
    currentIdentity(dep, root),
    dep.source.version?.declared(root) ?? null,
  ]);
  return { identity, version };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
