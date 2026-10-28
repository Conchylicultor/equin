import { z } from "zod";
import type { ResolvedExemption } from "./types";

/**
 * Why a manifest path is refused, or null when it is a canonical path inside
 * its plugin. Canonical — not normalized — on purpose: `./x`, `x/`, `a//b`
 * each name a file another spelling also names, and two spellings of one
 * exemption cannot be told apart as duplicates.
 */
export function manifestPathError(path: string): string | null {
  if (path === ".") return null;
  if (path === "") return 'is empty (use "." for the whole plugin)';
  if (path.startsWith("/"))
    return "is absolute — paths are relative to the declaring plugin";
  if (path.includes("\\")) return "uses \\ — separate segments with /";
  if (/[*?[\]{}!]/.test(path)) {
    return "is a glob — name a file, or a directory for its whole subtree";
  }
  if (path.endsWith("/")) return "ends with / — name the directory without it";
  for (const seg of path.split("/")) {
    if (seg === "..") {
      return "escapes the plugin with .. — a plugin can only exempt its own files";
    }
    if (seg === "." || seg === "") {
      return "is not canonical (a ./ or empty segment)";
    }
  }
  return null;
}

const pathSchema = z.string().superRefine((p, ctx) => {
  const err = manifestPathError(p);
  if (err !== null)
    ctx.addIssue({
      code: "custom",
      message: `path "${p}" ${err}`,
    });
});

const base = {
  rule: z.string().min(1),
  paths: z.array(pathSchema).min(1),
  reason: z.string().trim().min(1, "reason is required"),
};

const exemptionSchema = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("sanctioned") }).strict(),
  z
    .object({
      ...base,
      kind: z.literal("debt"),
      task: z
        .string()
        .trim()
        .min(1, "a debt exemption names the task that removes it"),
    })
    .strict(),
]);

const manifestSchema = z.array(exemptionSchema);

/** The repo-relative path a plugin-relative manifest path names. */
export function resolveTarget(plugin: string, path: string): string {
  return path === "." ? `plugins/${plugin}` : `plugins/${plugin}/${path}`;
}

/** Repo-relative path of `plugin`'s manifest. */
export function manifestPathOf(plugin: string): string {
  return `plugins/${plugin}/exempt/index.ts`;
}

/**
 * Validate one manifest's default export and resolve every path against its
 * plugin. Throws naming the manifest and each problem: a manifest the system
 * cannot read is not a manifest that exempts nothing.
 */
export function resolveManifest(
  plugin: string,
  value: unknown,
): ResolvedExemption[] {
  const manifest = manifestPathOf(plugin);
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (i) => `[${i.path.join(".")}] ${i.message}`,
    );
    throw new Error(
      `${manifest}: invalid exemption manifest:\n  ${problems.join("\n  ")}`,
    );
  }
  return parsed.data.flatMap((e) =>
    e.paths.map((path): ResolvedExemption => {
      const common = {
        rule: e.rule,
        plugin,
        manifest,
        path,
        target: resolveTarget(plugin, path),
        reason: e.reason,
      };
      return e.kind === "debt"
        ? { ...common, kind: "debt", task: e.task }
        : { ...common, kind: "sanctioned" };
    }),
  );
}

/** Whether exemption target `target` covers the repo-relative `path`. */
export function covers(target: string, path: string): boolean {
  return path === target || path.startsWith(`${target}/`);
}
