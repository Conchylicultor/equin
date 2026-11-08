// A migration as a report subject (packages/error-subject): its slug and
// phase, never its file name's `YYYYMMDD_HHMMSS_<hash>__` prefix — a branch
// regenerating one migration (a new timestamp and content hash, the same
// change) is one cause, so one report row.
export function migrationSubject(file: string, phase: string): string {
  const slug = file
    .replace(/^\d{8}_\d{6}_[0-9a-f]{8}__/, "")
    .replace(/\.sql$/, "");
  return `migration ${slug} (${phase})`;
}
