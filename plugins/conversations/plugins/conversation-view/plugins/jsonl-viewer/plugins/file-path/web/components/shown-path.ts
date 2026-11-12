/** A file path relative to the attempt's checkout; a path outside it is returned whole. */
export function toRelativePath(filePath: string, attemptId: string): string {
  // The attempt id can sit at a path boundary (`/att-xxx/…`) or as the suffix
  // of an encoded worktree-dir segment (`…-worktrees-att-xxx/…`), so anchor on
  // `<attemptId>/` rather than requiring a leading slash.
  const marker = `${attemptId}/`;
  const idx = filePath.indexOf(marker);
  return idx >= 0 ? filePath.slice(idx + marker.length) : filePath;
}
