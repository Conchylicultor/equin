import type { DeploySecretsData } from "./types";

/** Diff projection: one line per declared secret. */
export function deploySecretsToComparable(data: DeploySecretsData): string[] {
  return data.declared.map((d) => `${d.key} — ${d.description}`);
}
