import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import type { Dep, SystemPackages } from "./dep";

/**
 * Whether this machine has what a dependency needs from the operating system
 * (`Dep.systemPackages`):
 *
 * - `present` — every declared package is installed, or none is declared for
 *   this OS;
 * - `missing` — the packages still to install (`apt`), and what they are in a
 *   person's words;
 * - `unchecked` — packages are declared, but this machine cannot say (no
 *   dpkg: not a Debian / Ubuntu system). The install goes ahead and its build
 *   tool says what is missing.
 */
export type SystemPackagesCheck =
  | { readonly kind: "present" }
  | {
      readonly kind: "missing";
      readonly apt: readonly string[];
      readonly forUser: string;
    }
  | { readonly kind: "unchecked"; readonly reason: string };

/** A dependency's install refused up front: the OS packages it needs are missing. */
export class MissingSystemPackagesError extends Error {
  constructor(
    readonly depId: string,
    readonly apt: readonly string[],
    readonly forUser: string,
  ) {
    super(
      `${depId} needs ${forUser}, which are not installed: ${apt.join(" ")} — install them with \`sudo apt-get install ${apt.join(" ")}\``,
    );
    this.name = "MissingSystemPackagesError";
  }
}

const DPKG_TIMEOUT_MS = 30_000;
/** dpkg-query's own field syntax (not a template): one `name<TAB>status` row each. */
const DPKG_FORMAT = "-f=" + "$" + "{Package}\t" + "$" + "{Status}\n";

/** See {@link SystemPackagesCheck}. */
export async function checkSystemPackages(
  dep: Dep,
): Promise<SystemPackagesCheck> {
  const declared = declaredHere(dep.systemPackages);
  if (declared === null) return { kind: "present" };
  if (Bun.which("dpkg-query") === null)
    return {
      kind: "unchecked",
      reason: "no dpkg-query on PATH (not a Debian / Ubuntu system)",
    };
  // One call for the whole list. A name dpkg has never heard of is reported
  // on stderr (and the exit is 1): it is missing, like one not installed.
  const result = await spawnCaptured(
    ["dpkg-query", "-W", DPKG_FORMAT, ...declared.apt],
    { timeoutMs: DPKG_TIMEOUT_MS },
  );
  const missing = missingPackages(result.stdout, declared.apt);
  return missing.length === 0
    ? { kind: "present" }
    : { kind: "missing", apt: missing, forUser: declared.forUser };
}

/** Fails the install before it starts when a declared package is missing. */
export async function assertSystemPackages(dep: Dep): Promise<void> {
  const check = await checkSystemPackages(dep);
  if (check.kind === "missing")
    throw new MissingSystemPackagesError(dep.id, check.apt, check.forUser);
}

/** The declaration for this OS, or null when it needs nothing here. */
function declaredHere(
  packages: SystemPackages | null,
): SystemPackages["linux"] | null {
  if (packages === null || process.platform !== "linux") return null;
  return packages.linux.apt.length === 0 ? null : packages.linux;
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
