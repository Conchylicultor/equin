import type { RoutedSource } from "@plugins/infra/plugins/query-resource/server";

// The tables each registered worktree provider reads, filled during the
// register phase (before the catalog values' reads are bound). Process state,
// like the shared provider registry; central providers read no worktree
// Postgres, so the shared spec carries no tables.
const tablesByKind = new Map<string, readonly RoutedSource[]>();

export function addProviderTables(
  kind: string,
  tables: readonly RoutedSource[],
): void {
  tablesByKind.set(kind, tables);
}

/** Every table any registered provider reads, each once. */
export function registeredProviderTables(): RoutedSource[] {
  return [...new Set([...tablesByKind.values()].flat())];
}
