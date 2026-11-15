import type { ConfigRegistration } from "./config-registrations";

/** What a registered descriptor must expose for its defaults to be checked. */
interface CheckableDescriptor {
  name: string;
  schema: {
    safeParse(value: unknown): {
      success: boolean;
      error?: {
        issues: readonly { path: readonly PropertyKey[]; message: string }[];
      };
    };
  };
  defaults: unknown;
}

function isCheckable(d: unknown): d is CheckableDescriptor {
  return (
    typeof d === "object" &&
    d !== null &&
    "schema" in d &&
    "defaults" in d &&
    typeof (d as { name?: unknown }).name === "string"
  );
}

/**
 * Every registered descriptor whose defaults its own schema rejects — the
 * build-time home of the default check. `defineConfig` composes its schema on
 * first read (never at module evaluation, so a page load parses no default),
 * so this is where every config's schema is composed: a field whose default
 * does not parse throws there (`FieldDefaultError`, naming the field type),
 * and the composed defaults are then parsed as the document a fresh install
 * seeds. One line per failing descriptor; each descriptor object once, however
 * many runtimes register it.
 */
export function configDefaultFailures(
  registrations: readonly ConfigRegistration[],
): string[] {
  const seen = new Set<unknown>();
  const failures: string[] = [];
  for (const r of registrations) {
    const d = r.descriptor;
    if (seen.has(d)) continue;
    seen.add(d);
    if (!isCheckable(d)) {
      failures.push(
        `${r.storePath} (${r.barrel}): the registered descriptor has no schema / defaults — register what defineConfig returns`,
      );
      continue;
    }
    let result: ReturnType<CheckableDescriptor["schema"]["safeParse"]>;
    try {
      result = d.schema.safeParse(d.defaults);
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      failures.push(`${r.storePath} (${r.barrel}): ${err.message}`);
      continue;
    }
    if (result.success) continue;
    const issues = (result.error?.issues ?? [])
      .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    failures.push(
      `${r.storePath} (${r.barrel}): its defaults do not parse against its own schema — ${issues}`,
    );
  }
  return failures;
}
