import { resolve } from "path";
import { MIGRATIONS_PLUGIN_DIR } from "@plugins/database/plugins/migrations/core";
import type { RepoFiles } from "@plugins/framework/plugins/tooling/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import {
  closureRecord,
  repoModuleOf,
} from "@plugins/plugin-meta/plugins/plugin-records/core";
import type { ProbeInput, ProbeOutput } from "./probe-types";

export type ProbeResult =
  | ({ readonly kind: "ok" } & ProbeOutput)
  | { readonly kind: "probe-failed"; readonly message: string };

const PROBE_URL = new URL("./schema-probe.ts", import.meta.url).href;

/**
 * Run `schema-probe.ts` in one subprocess, the way `derived-updated-at:declared`
 * runs its probe: from the migrations plugin dir (drizzle-kit's cwd) with
 * drizzle-kit's own environment, so a schema file loads exactly as migration
 * generation loads it, into a fresh derived-updatedAt registry.
 *
 * Its answer is a function of the code it loads — the probe script and every
 * schema file, each with its import closure — and of its input, so it is a
 * plugin record (`closureRecord`): the probe runs once per distinct schema
 * closure host-wide, and a pass after an edit no schema file reaches is a
 * lookup. A probe that failed to run (a crash, a timeout) is not stored.
 */
export async function runSchemaProbe(
  repo: RepoFiles,
  input: ProbeInput,
): Promise<ProbeResult> {
  const probe = repoModuleOf(repo, PROBE_URL);
  const answer = await closureRecord<ProbeOutput, string>(
    repo,
    {
      name: "sql-writes:schema-probe",
      modules: [probe, ...input.files],
      input,
    },
    async () => {
      const result = await spawnCaptured(
        [process.execPath, "--bun", resolve(repo.root, probe), repo.root],
        {
          cwd: resolve(repo.root, MIGRATIONS_PLUGIN_DIR),
          env: { ...process.env, NO_COLOR: "1" },
          stdin: JSON.stringify(input),
          // Seconds of module loading; three minutes only bounds a schema file whose
          // module scope never returns (same bound as schema-files-loadable).
          timeoutMs: 180_000,
        },
      );
      try {
        if (result.exitCode !== 0)
          throw new Error(`exit code ${result.exitCode}`);
        return { ok: true, value: JSON.parse(result.stdout) as ProbeOutput };
      } catch (err) {
        return {
          ok: false,
          error:
            `sql-writes schema probe failed (${String(err)}).\n` +
            `exit code: ${result.exitCode}\nstderr:\n${result.stderr}\nstdout:\n${result.stdout.slice(0, 4000)}`,
        };
      }
    },
  );
  return answer.ok
    ? { kind: "ok", ...answer.value }
    : { kind: "probe-failed", message: answer.error };
}
