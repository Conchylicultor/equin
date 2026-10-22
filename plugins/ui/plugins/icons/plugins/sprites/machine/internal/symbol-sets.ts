import type { IconifyJSON } from "@iconify/types";
import type { SymbolSets } from "@plugins/ui/plugins/icons/server";
import { ICON_SETS, type IconSetSource } from "./icon-sets";

/**
 * The Iconify sets the sprites are built from, embedded in the build (see
 * `icon-sets.js`) — never looked up in node_modules at runtime.
 */
export const PACKAGE = ICON_SETS;

/** `<package>@<version>`: what a sprite built from `pkg` is a function of. */
export function setIdentity(
  pkg: Pick<IconSetSource, "name" | "version">,
): string {
  return `${pkg.name}@${pkg.version}`;
}

export async function readSet(pkg: IconSetSource): Promise<IconifyJSON> {
  return (await Bun.file(pkg.file).json()) as IconifyJSON;
}

interface Lease {
  readonly sets: Promise<SymbolSets>;
  users: number;
}

// The parsed Material Symbols sets (~19 MB of JSON), shared by whoever needs
// them at the same moment — the manifest sprites and a runtime-symbol style
// build at boot, say — and dropped when the last one is done: every consumer
// keeps only what it built from them.
let lease: Lease | null = null;

/**
 * Run `fn` over the two parsed Material Symbols sets. Concurrent callers share
 * one parse; the sets are released when the last caller returns. A failed
 * parse is not kept: the next call parses again (and fails loudly again).
 */
export async function withSymbolSets<T>(
  fn: (sets: SymbolSets) => T | Promise<T>,
): Promise<T> {
  lease ??= {
    sets: Promise.all([readSet(PACKAGE.regular), readSet(PACKAGE.light)]).then(
      ([regular, light]) => ({ regular, light }),
    ),
    users: 0,
  };
  const held = lease;
  held.users++;
  try {
    return await fn(await held.sets);
  } finally {
    held.users--;
    if (held.users === 0 && lease === held) lease = null;
  }
}
