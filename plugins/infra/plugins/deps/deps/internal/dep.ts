import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import type { ExecContext } from "@plugins/infra/plugins/jobs/plugins/supervised-job/core";
import type { DepUpdates } from "../../core";

/**
 * What an installer kind hands `install`: the checkout the declaration lives
 * in, the directory to fill, and the engine's logging.
 */
export interface InstallContext {
  /** The checkout whose declaration derived this identity (its repo root). */
  readonly root: string;
  /**
   * The directory to fill. It does not exist yet (a partial one from an
   * interrupted install has been removed). The kind creates it.
   */
  readonly dir: AppPath;
  /** One line to the caller's log (a job transcript, the terminal). */
  readonly log: (line: string) => void;
  /**
   * Run one command with its stdout and stderr appended to the install log as
   * they are written, so `depState`'s `logTail` follows a long install. Throws
   * on a non-zero exit, naming the command and the log's tail.
   */
  readonly run: (
    argv: readonly string[],
    opts: {
      cwd: string;
      env: Record<string, string | undefined>;
      timeoutMs: number;
      /**
       * The command's output as it is written (each chunk the log grew by,
       * `\r` progress frames included), for a kind that reads progress out
       * of it — called only while someone listens (`progress` is not null).
       */
      onOutput?: (chunk: string) => void;
    },
  ) => Promise<void>;
  readonly exec: ExecContext;
  /**
   * Where the kind reports how far the install is, as its tool counts (cargo's
   * crates), or null when nobody listens — a kind then asks its tool for no
   * progress output at all. What the caller passed as
   * `EnsureOptions.progress` (an install's window shows it).
   */
  readonly progress: ((p: DepProgress) => void) | null;
}

/** How far an install is, as its tool counts. */
export interface DepProgress {
  readonly done: number;
  /** Null until the tool has said how much there is. */
  readonly total: number | null;
  readonly unit: "crates";
}

/** The platform and architecture an install is FOR (Node's spelling). */
export interface DepTarget {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
}

/** This host, as a target. */
export function hostTarget(): DepTarget {
  return { platform: process.platform, arch: process.arch };
}

export function sameTarget(a: DepTarget, b: DepTarget): boolean {
  return a.platform === b.platform && a.arch === b.arch;
}

export function targetLabel(t: DepTarget): string {
  return `${t.platform}/${t.arch}`;
}

/**
 * What {@link DepSource.forTarget} answers: the source specialised to install
 * FOR `target` (its identity names the target), or why this kind cannot.
 */
export type TargetedSource =
  { ok: true; source: DepSource } | { ok: false; reason: string };

/**
 * An installer kind's contribution for one declared source: an open set of
 * sub-plugins under `infra/deps/plugins/<kind>` (this task ships `python`).
 */
export interface DepSource<K extends string = string> {
  readonly kind: K;
  /** What it installs from, for people: the uv project's path, a URL, … */
  readonly label: string;
  /**
   * The declared inputs this install is a function of — lock hash, source
   * hash, pinned URL + sha256, plus the installer's own version — derived, never
   * typed in by hand. The engine hashes them into the identity, so a change in
   * any of them is a new identity and so a new install.
   *
   * `root` is the checkout to read the inputs from: the running one, or (for
   * the sweep) any other checkout on the machine. Throws when an input cannot
   * be read (the installer is missing) — never a stand-in value.
   */
  identityInputs(root: string): Promise<Readonly<Record<string, string>>>;
  /** Fill `ctx.dir`. Throws on any failure; the engine records it. */
  install(ctx: InstallContext): Promise<void>;
  /**
   * Whether an installed payload is still whole — for a payload that points
   * outside itself (a venv's `bin/python` is a symlink into uv's managed
   * Pythons, a reclaimable cache). Cheap — it runs on every
   * `ensureDep` fast path and every state read — and it never blocks the
   * thread: a probe of the disk is async (a plain answer is fine when it
   * needs none). An install that is no longer
   * intact reads as `absent` and is installed again. Omitted: always intact.
   */
  isIntact?(dir: AppPath): boolean | Promise<boolean>;
  /**
   * How the install is admitted to the host. Omitted: under the caller's
   * `exec.admit` (one unit of `withHostGrant` in its lane), so a big install
   * yields host CPU to builds and interactive work.
   *
   * `{ none: "<why>" }`: the install runs at once, taking no grant — only for
   * an install too small to be worth one (compiling one C file) that a caller
   * awaits on the way INTO an op of its own. Queuing there for a background
   * unit would hold the op behind the whole background lane before it even
   * asks for its own grant, and inside an op already holding the host's slots
   * it could wait for ever. The reason is required, so skipping admission is a
   * visible decision, never an omission.
   */
  readonly admission?: { readonly none: string };
  /**
   * The updater that moves this source's declared inputs to newer releases
   * (`uv` for a Python project). A kind that has one makes `updates` implied.
   */
  readonly updater?: string;
  /**
   * This source, installing for `target` instead of this host — what
   * `sealDep` runs to put a dependency into a release bundle built for another
   * platform (and, for this host's own target, the same thing the cache holds).
   * The returned source's identity must name the target, so a foreign install
   * never shares an identity with a host one.
   *
   * Only a kind whose payload is relocatable (it can be copied into a bundle and
   * run from there) implements it; a declaration may say `bundle` only when its
   * source has it (tsc). `{ ok: false }` says honestly that the kind cannot
   * produce `target` here (a C compiler with no cross sysroot).
   */
  forTarget?(target: DepTarget): TargetedSource;
  /**
   * The version of what this source installs, for people: as a checkout
   * declares it (`declared(root)`, e.g. its lock entry) and as an install
   * holds it (`installed(dir)`, read from the payload itself). Lets a pinned
   * dependency say "18.1.0 → 18.6.0" rather than two identity hashes, and is
   * what a pin's `switchBlocked` compares. Each throws when it cannot read
   * the version — never a stand-in. Omitted: the identity alone names it.
   */
  readonly version?: SourceVersion;
}

/** How a source reads its version (see {@link DepSource.version}). */
export interface SourceVersion {
  declared(root: string): Promise<string>;
  installed(dir: AppPath): Promise<string>;
}

/** How a declaration states it stays current when its source has no updater. */
type UpdatesSpec<S extends DepSource> = S extends { readonly updater: string }
  ? { updates?: never }
  : {
      /**
       * Required: a dependency says how it stays current. A source with no
       * updater (a dataset pinned to a commit) must say why it is frozen, so
       * being frozen is a visible decision, never an omission.
       */
      updates: { none: string };
    };

/**
 * Whether a release bundle carries this dependency, sealed for the bundle's
 * platform (`sealDep`): a bundle has no source, no toolchain and no network to
 * install anything at run time.
 *
 * - `"required"` — the bundle is broken without it (the gateway binary): a
 *   target the kind cannot produce fails the release.
 * - `{ optional: "<what the app does without it>" }` — sealed where the kind
 *   can produce the target, left out (and recorded as such in the manifest)
 *   where it cannot.
 */
export type BundleSpec = "required" | { readonly optional: string };

/** Only a source that can install for a target can be sealed into a bundle. */
type BundleField<S extends DepSource> = S extends {
  readonly forTarget: (target: DepTarget) => TargetedSource;
}
  ? { bundle?: BundleSpec }
  : { bundle?: never };

/**
 * A dependency something OUTSIDE any checkout runs from (a host daemon), which
 * must never change under it by a checkout moving on: what it runs is the
 * install PINNED to it — a hold named `holder` — not the checkout's current
 * identity. Adopted once (the first start pins the checkout's install);
 * afterwards only `pinDep` (`./equin deps pin <id>`) moves it, on purpose,
 * and it takes effect at `appliesAt`. See `pinnedDep`.
 */
export interface DepPin {
  /** The hold that names the pinned install (`^[a-z][a-z0-9-]*$`). */
  readonly holder: string;
  /** When a moved pin takes effect, for people: "the cluster's next full restart". */
  readonly appliesAt: string;
  /**
   * Why moving the pin from version `from` to version `to` is NOT a plain
   * switch (a Postgres major: the cluster's data must be migrated first), or
   * null when it is. `pinDep` refuses a blocked move, and the pinned-deps
   * health row shows it as blocked rather than offering the switch. Needs the
   * source's `version` (checked by `defineDep`).
   */
  readonly switchBlocked?: (from: string, to: string) => string | null;
}

/**
 * What an install needs from the operating system that no installer kind
 * provides: the libraries a native build links against (the menu-bar icon's
 * GTK and WebKitGTK on Linux). Declared beside the dependency so whoever
 * prepares a machine (install.sh, through `./equin start --system-packages`)
 * installs them from the declaration, never from a list of its own. Linux
 * only, by Debian / Ubuntu package name: apt is the one package manager the
 * installer drives. Checked before an install (`checkSystemPackages`): a
 * missing one fails it as a `MissingSystemPackagesError`, naming them, rather
 * than as the build tool's own error halfway in.
 */
export interface SystemPackages {
  readonly linux: {
    /** Debian / Ubuntu package names. */
    readonly apt: readonly string[];
    /** What they are, in a person's words: "the GTK and WebKitGTK libraries". */
    readonly forUser: string;
  };
}

export type DefineDepSpec<S extends DepSource> = {
  /** Stable id: the cache dir name and the CLI argument. `^[a-z][a-z0-9-]*$`. */
  id: string;
  /** The declaring plugin's path, e.g. `infra/audio-analysis`. */
  owner: string;
  description: string;
  /** A human estimate of the install's size, e.g. `≈40 MB`. */
  sizeHint: string;
  source: S;
  /** Run from a pinned install, switched only on purpose (see {@link DepPin}). */
  pin?: DepPin;
  /** What the install needs from the operating system (see {@link SystemPackages}). */
  systemPackages?: SystemPackages;
} & UpdatesSpec<S> &
  BundleField<S>;

/** A declared dependency. Created only by {@link defineDep}. */
export interface Dep<S extends DepSource = DepSource> {
  readonly id: string;
  readonly owner: string;
  readonly description: string;
  readonly sizeHint: string;
  readonly source: S;
  readonly updates: DepUpdates;
  /** Sealed into release bundles, and whether a bundle may go without it. `null`: never bundled. */
  readonly bundle: BundleSpec | null;
  /** Run from a pinned install (see {@link DepPin}). `null`: from the checkout's current identity. */
  readonly pin: DepPin | null;
  /** What the install needs from the operating system (see {@link SystemPackages}). `null`: nothing. */
  readonly systemPackages: SystemPackages | null;
}

const DEP_ID = /^[a-z][a-z0-9-]*$/;

/**
 * Declare a dependency: installed on demand (`ensureDep` / `requestDep`), into
 * a content-addressed host-wide cache, with its state visible (`depState`, the
 * `deps.states` live value) and its way of staying current stated.
 *
 * Declaring it is not registering it: export it from the declaring plugin's
 * `deps/index.ts` and list it in that file's `default` array. Codegen collects
 * every such file into `infra/deps`' registry, which is what puts it in the
 * Dependencies view, the CLI and the sweep's set.
 */
export function defineDep<S extends DepSource>(spec: DefineDepSpec<S>): Dep<S> {
  if (!DEP_ID.test(spec.id)) {
    throw new Error(
      `defineDep: id ${JSON.stringify(spec.id)} must match ${DEP_ID} — it names a cache directory and a CLI argument.`,
    );
  }
  const updater = spec.source.updater;
  const frozen = (spec as { updates?: { none: string } }).updates;
  const updates: DepUpdates =
    updater !== undefined
      ? { kind: "updater", updater }
      : { kind: "none", reason: requireReason(spec.id, frozen) };
  return {
    id: spec.id,
    owner: spec.owner,
    description: spec.description,
    sizeHint: spec.sizeHint,
    source: spec.source,
    updates,
    bundle: bundleOf(spec.id, spec as { bundle?: BundleSpec }),
    pin: pinOf(spec.id, spec.pin, spec.source),
    systemPackages: spec.systemPackages ?? null,
  };
}

const HOLDER = /^[a-z][a-z0-9-]*$/;

function pinOf(
  id: string,
  pin: DepPin | undefined,
  source: DepSource,
): DepPin | null {
  if (pin === undefined) return null;
  if (!HOLDER.test(pin.holder) || pin.appliesAt.trim() === "") {
    throw new Error(
      `defineDep(${id}): pin.holder must match ${HOLDER} and pin.appliesAt must say when a moved pin takes effect.`,
    );
  }
  if (pin.switchBlocked !== undefined && source.version === undefined) {
    throw new Error(
      `defineDep(${id}): pin.switchBlocked compares versions, but its ${source.kind} source reads none (DepSource.version).`,
    );
  }
  return pin;
}

function bundleOf(
  id: string,
  spec: { bundle?: BundleSpec },
): BundleSpec | null {
  const bundle = spec.bundle;
  if (bundle === undefined) return null;
  // Unreachable through the types; kept for an untyped caller.
  if (bundle !== "required" && bundle.optional.trim() === "") {
    throw new Error(
      `defineDep(${id}): bundle: { optional } must say what the app does without it.`,
    );
  }
  return bundle;
}

function requireReason(
  id: string,
  frozen: { none: string } | undefined,
): string {
  // Unreachable through the types; kept for an untyped caller.
  if (frozen === undefined || frozen.none.trim() === "") {
    throw new Error(
      `defineDep(${id}): its source has no updater, so it must say why it is frozen: updates: { none: "<reason>" }.`,
    );
  }
  return frozen.none;
}

declare const readyBrand: unique symbol;

/**
 * Proof that a dependency is installed: returned only by `ensureDep` (and
 * `readyNow`'s `ready` arm). Runners
 * (`runPython`) take it as an argument, so "forgot to ensure" is a type error.
 */
export interface Ready<S extends DepSource = DepSource> {
  readonly [readyBrand]: true;
  readonly dep: Dep<S>;
  /** The installed payload (`<cache>/<id>/<identity>/env`). */
  readonly dir: AppPath;
  readonly identity: string;
}

/** The engine's one mint of a `Ready`. Not exported from the barrel. */
export function mintReady<S extends DepSource>(
  dep: Dep<S>,
  dir: AppPath,
  identity: string,
): Ready<S> {
  return { dep, dir, identity } as Ready<S>;
}
