/**
 * The order a host folder's entries are shown in, as people sort: by name,
 * numbers compared as numbers (`2` before `10`), case and accents only
 * breaking ties. The one statement of it — host-fs's own ordering and every
 * reader that re-sorts a listing (`host-fs.list` pages arrive in code-point
 * order, which only cuts pages) use it.
 */
export function compareHostFsNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}
