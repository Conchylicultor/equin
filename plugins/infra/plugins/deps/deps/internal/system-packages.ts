import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import type {
  AptPackages,
  Dep,
  SystemPackages,
  ToolInstalledPackages,
} from "./dep";

/**
 * Whether this machine has what a dependency needs from the operating system
 * (`Dep.systemPackages`):
 *
 * - `present` — every declared package is installed, or none is declared for
 *   this OS;
 * - `missing` — some are not: the command that installs them (run as root),
 *   the apt names when the declaration lists them (empty when a tool of the
 *   dependency's own installs them), and what they are in a person's words.
 *   `certain` is false when the tool could not tell (its apt simulation
 *   failed): whoever can run the command runs it anyway, an install does not
 *   refuse on it;
 * - `unchecked` — packages are declared, but this machine cannot say (no
 *   dpkg: not a Debian / Ubuntu system). The install goes ahead and its build
 *   tool says what is missing.
 */
export type SystemPackagesCheck =
  | { readonly kind: "present" }
  | {
      readonly kind: "missing";
      readonly apt: readonly string[];
      readonly command: readonly string[];
      readonly forUser: string;
      readonly certain: boolean;
    }
  | { readonly kind: "unchecked"; readonly reason: string };

/** A dependency's install refused up front: the OS packages it needs are missing. */
export class MissingSystemPackagesError extends Error {
  constructor(
    readonly depId: string,
    /** The apt names, when the declaration lists them; empty when a tool installs them. */
    readonly apt: readonly string[],
    readonly forUser: string,
    /** The command that installs them, run as root. */
    readonly command: readonly string[],
  ) {
    super(
      `${depId} needs ${forUser}, which are not installed${apt.length > 0 ? `: ${apt.join(" ")}` : ""} — install them with \`sudo ${command.join(" ")}\``,
    );
    this.name = "MissingSystemPackagesError";
  }
}

const DPKG_TIMEOUT_MS = 30_000;
/** dpkg-query's own field syntax (not a template): one `name<TAB>status` row each. */
const DPKG_FORMAT = "-f=" + "$" + "{Package}\t" + "$" + "{Status}\n";

/** See {@link SystemPackagesCheck}. `root`: the checkout a tool is resolved from. */
export async function checkSystemPackages(
  dep: Dep,
  root: string,
): Promise<SystemPackagesCheck> {
  const declared = declaredHere(dep.systemPackages);
  if (declared === null) return { kind: "present" };
  if (Bun.which("dpkg-query") === null)
    return {
      kind: "unchecked",
      reason: "no dpkg-query on PATH (not a Debian / Ubuntu system)",
    };
  return isTool(declared) ? checkTool(declared, root) : checkApt(declared);
}

async function checkApt(declared: AptPackages): Promise<SystemPackagesCheck> {
  // One call for the whole list. A name dpkg has never heard of is reported
  // on stderr (and the exit is 1): it is missing, like one not installed.
  const result = await spawnCaptured(
    ["dpkg-query", "-W", DPKG_FORMAT, ...declared.apt],
    { timeoutMs: DPKG_TIMEOUT_MS },
  );
  const missing = missingPackages(result.stdout, declared.apt);
  return missing.length === 0
    ? { kind: "present" }
    : {
        kind: "missing",
        apt: missing,
        command: ["apt-get", "install", ...missing],
        forUser: declared.forUser,
        certain: true,
      };
}

async function checkTool(
  declared: ToolInstalledPackages,
  root: string,
): Promise<SystemPackagesCheck> {
  const check = await declared.check(root);
  if (check.kind === "present") return { kind: "present" };
  return {
    kind: "missing",
    apt: [],
    command: await declared.installCommand(root),
    forUser: declared.forUser,
    certain: check.kind === "missing",
  };
}

/**
 * Fails the install before it starts when a declared package is missing — a
 * tool's `unknown` lets it go ahead (its own launch check says what is
 * missing after).
 */
export async function assertSystemPackages(
  dep: Dep,
  root: string,
): Promise<void> {
  const check = await checkSystemPackages(dep, root);
  if (check.kind === "missing" && check.certain)
    throw new MissingSystemPackagesError(
      dep.id,
      check.apt,
      check.forUser,
      check.command,
    );
}

/**
 * What install.sh prepares on this Linux machine for `deps` (the parts a
 * start adds) plus every declared dependency whose packages EVERY install
 * prepares (`SystemPackages.everyInstall`): the apt names to install in one
 * apt call, and the commands a dependency's own tool installs them with.
 */
export async function systemPackagesToPrepare(
  deps: readonly Dep[],
  declared: readonly Dep[],
  root: string,
): Promise<{ apt: string[]; commands: SetupCommand[] }> {
  const wanted = new Map<string, Dep>();
  for (const dep of [
    ...deps,
    ...declared.filter((d) => d.systemPackages?.everyInstall !== undefined),
  ])
    wanted.set(dep.id, dep);
  const apt = new Set<string>();
  const commands: SetupCommand[] = [];
  for (const dep of wanted.values()) {
    const check = await checkSystemPackages(dep, root);
    if (check.kind !== "missing") continue;
    if (check.apt.length > 0) for (const p of check.apt) apt.add(p);
    else commands.push({ forUser: check.forUser, argv: check.command });
  }
  return { apt: [...apt], commands };
}

/** A command a dependency's own tool installs its OS packages with, run as root. */
export interface SetupCommand {
  readonly forUser: string;
  readonly argv: readonly string[];
}

/** The declaration for this OS, or null when it needs nothing here. */
function declaredHere(
  packages: SystemPackages | null,
): SystemPackages["linux"] | null {
  if (packages === null || process.platform !== "linux") return null;
  if (isTool(packages.linux)) return packages.linux;
  return packages.linux.apt.length === 0 ? null : packages.linux;
}

function isTool(
  linux: SystemPackages["linux"],
): linux is ToolInstalledPackages {
  return !("apt" in linux);
}

/**
 * The wanted packages `dpkg-query -W -f='${Package}\t${Status}\n'` does not
 * report as installed (`install ok installed`; a removed package keeps a
 * `deinstall ok config-files` row, and an unknown one has no row at all).
 * Architecture-qualified names (`libfoo:arm64`) match their bare name.
 */
export function missingPackages(
  dpkgOutput: string,
  wanted: readonly string[],
): string[] {
  const installed = new Set<string>();
  for (const line of dpkgOutput.split("\n")) {
    const [name, status] = line.split("\t");
    if (name === undefined || status === undefined) continue;
    if (status.trim().split(/\s+/).at(-1) === "installed")
      installed.add(name.split(":")[0]!);
  }
  return wanted.filter((p) => !installed.has(p.split(":")[0]!));
}
