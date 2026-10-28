import type { MandatePolicy } from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/policy/core";
import { interactiveMandate } from "@plugins/tasks/plugins/mandate-presets/core";

/**
 * Where a task a person files from the UI goes: under `folderId` (inheriting
 * its mandate), or — no folder — a root under the interactive mandate a
 * person's own task gets.
 */
export function interactivePlacement(
  folderId: string | null | undefined,
): { folderId: string } | { mandate: MandatePolicy } {
  return folderId ? { folderId } : { mandate: interactiveMandate() };
}
