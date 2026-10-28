const SI_UNITS = ["kB", "MB", "GB", "TB", "PB"] as const;

/**
 * A byte count as a person reads it at a glance — the byte-size type's one
 * spelling, in SI (base-1000) units as file browsers count: `840 B`,
 * `18.4 kB`, `84.2 MB`, `512 MB`, `1.5 GB` (one decimal under a hundred of a
 * unit).
 */
export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes))
    throw new Error(`formatByteSize: ${bytes} is not a size`);
  if (bytes < 0) return `-${formatByteSize(-bytes)}`;
  if (Math.round(bytes) < 1000) return `${Math.round(bytes)} B`;
  let value = bytes;
  for (const unit of SI_UNITS) {
    value /= 1000;
    const shown =
      value < 99.95 ? Math.round(value * 10) / 10 : Math.round(value);
    if (shown < 1000 || unit === SI_UNITS.at(-1)) {
      return `${shown < 100 ? shown.toFixed(1) : shown} ${unit}`;
    }
  }
  throw new Error("formatByteSize: unreachable");
}

const UNIT_BYTES: Readonly<Record<string, number>> = {
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
  pb: 1e15,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
  k: 1e3,
  m: 1e6,
  g: 1e9,
  t: 1e12,
};

const SIZE = /^(\d+(?:\.\d+)?|\.\d+)\s*([a-z]*)$/;

/**
 * A size typed by a person → its bytes: `1 GB`, `500kB`, `1.5gb`, `12 B`,
 * binary `4 GiB`, or a bare number (bytes). `null` when the text is not a size.
 */
export function parseByteSize(raw: string): number | null {
  const match = SIZE.exec(raw.trim().toLowerCase());
  if (!match) return null;
  const scale = UNIT_BYTES[match[2] === "" ? "b" : match[2]!];
  if (scale === undefined) return null;
  return Math.round(Number(match[1]) * scale);
}
