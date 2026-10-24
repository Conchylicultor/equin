/**
 * How an installed gateway launch differs from the one `./equin start --force`
 * would write — one short phrase per difference, for the health report's
 * summary. Pure.
 *
 * Every gateway flag takes a value (`gatewayLaunchFlags`), so the flags are
 * compared as a `-flag → value` map: order is not a difference, a new or a
 * dropped flag is, and so is a changed value. A comma list (`-child-env`) is
 * compared as a set, naming what was added and removed.
 */
export function diffGatewayFlags(
  installed: readonly string[],
  expected: readonly string[],
): string[] {
  const was = flagMap(installed);
  const now = flagMap(expected);
  const out: string[] = [];
  for (const [flag, value] of now) {
    const before = was.get(flag);
    if (before === undefined) out.push(`new ${flag}`);
    else if (before !== value) out.push(describeChange(flag, before, value));
  }
  for (const flag of was.keys()) {
    if (!now.has(flag)) out.push(`dropped ${flag}`);
  }
  return out;
}

/** The value of `flag` in a flag list, or undefined. */
export function flagValue(
  flags: readonly string[],
  flag: string,
): string | undefined {
  return flagMap(flags).get(flag);
}

/**
 * A gateway binary's `gateway-binary` identity, read off its install path
 * (`…/gateway-binary/<identity>/env/gateway`), or null for any other path.
 */
export function binaryIdentity(path: string): string | null {
  return /\/gateway-binary\/([^/]+)\//.exec(path)?.[1] ?? null;
}

function flagMap(flags: readonly string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < flags.length; i += 2) {
    map.set(flags[i]!, flags[i + 1] ?? "");
  }
  return map;
}

const SHORT_VALUE = 32;
const LISTED = 3;

function describeChange(flag: string, before: string, after: string): string {
  if (before.includes(",") || after.includes(",")) {
    const was = new Set(before.split(","));
    const now = new Set(after.split(","));
    const added = [...now].filter((v) => !was.has(v)).map((v) => `+${v}`);
    const removed = [...was].filter((v) => !now.has(v)).map((v) => `−${v}`);
    const changes = [...added, ...removed];
    // Same set, other order: still a different argv.
    if (changes.length === 0) return `${flag} reordered`;
    const listed = changes.slice(0, LISTED).join(", ");
    const more =
      changes.length > LISTED ? ` and ${changes.length - LISTED} more` : "";
    return `${flag} ${listed}${more}`;
  }
  if (before.length <= SHORT_VALUE && after.length <= SHORT_VALUE) {
    return `${flag} ${before === "" ? '""' : before} → ${after === "" ? '""' : after}`;
  }
  return `${flag} changed`;
}
