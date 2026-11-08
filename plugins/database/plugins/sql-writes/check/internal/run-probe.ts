import { resolve } from "path";
import { MIGRATIONS_PLUGIN_DIR } from "@plugins/database/plugins/migrations/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import type { ProbeInput, ProbeOutput } from "./probe-types";

export type ProbeResult =
  | ({ readonly kind: "ok" } & ProbeOutput)
  | { readonly kind: "probe-failed"; readonly message: string };

/**
 * Run `schema-probe.ts` in one subprocess, the way `derived-updated-at:declared`
 * runs its probe: from the migrations plugin dir (drizzle-kit's cwd) with
 * drizzle-kit's own environment, so a schema file loads exactly as migration
 * generation loads it, into a fresh derived-updatedAt registry.
 */
export async function runSchemaProbe(
  root: string,
  input: ProbeInput,
): Promise<ProbeResult> {
  const result = await spawnCaptured(
    [process.execPath, "--bun", resolve(import.meta.dir, "schema-probe.ts")],
    {
      cwd: resolve(root, MIGRATIONS_PLUGIN_DIR),
      env: { ...process.env, NO_COLOR: "1" },
      stdin: JSON.stringify(input),
      // Seconds of module loading; three minutes only bounds a schema file whose
      // module scope never returns (same bound as schema-files-loadable).
      timeoutMs: 180_000,
    },
  );
  try {
    if (result.exitCode !== 0) throw new Error(`exit code ${result.exitCode}`);
    return { kind: "ok", ...(JSON.parse(result.stdout) as ProbeOutput) };
  } catch (err) {
    return {
      kind: "probe-failed",
      message:
        `sql-writes schema probe failed (${String(err)}).\n` +
        `exit code: ${result.exitCode}\nstderr:\n${result.stderr}\nstdout:\n${result.stdout.slice(0, 4000)}`,
    };
  }
}
