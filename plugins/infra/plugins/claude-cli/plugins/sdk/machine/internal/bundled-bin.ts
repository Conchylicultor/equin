import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const SDK = "@anthropic-ai/claude-agent-sdk";

/** The bundled build's platform packages, in the order the SDK itself tries them. */
export function bundledClaudePackages(
  platform: NodeJS.Platform,
  arch: string,
  musl: boolean,
): string[] {
  const ext = platform === "win32" ? ".exe" : "";
  const names =
    platform === "linux"
      ? musl
        ? [`${SDK}-linux-${arch}-musl`, `${SDK}-linux-${arch}`]
        : [`${SDK}-linux-${arch}`, `${SDK}-linux-${arch}-musl`]
      : [`${SDK}-${platform}-${arch}`];
  return names.map((name) => `${name}/claude${ext}`);
}

function isMusl(): boolean {
  if (process.platform !== "linux") return false;
  const report = process.report.getReport() as {
    header?: { glibcVersionRuntime?: string };
  };
  return report.header?.glibcVersionRuntime === undefined;
}

/** The SDK's bundled Claude Code is not where the installed SDK puts it. */
export class BundledClaudeMissingError extends Error {
  constructor(tried: string[]) {
    super(
      `The Agent SDK's bundled Claude Code is not installed (tried ${tried.join(", ")}). ` +
        "It ships as an optional dependency of @anthropic-ai/claude-agent-sdk for this platform: reinstall dependencies (./equin build).",
    );
    this.name = "BundledClaudeMissingError";
  }
}

/**
 * The Claude Code executable every session runs: the build the installed
 * Agent SDK ships (its per-platform optional dependency, pinned by bun.lock),
 * resolved from the SDK's own location as the SDK resolves its default — the
 * platform package is the SDK's dependency, not ours, so it is not hoisted
 * into any workspace. The computer's own `claude` install is never used.
 *
 * Throws {@link BundledClaudeMissingError} when it is absent: a broken install
 * (or an unsupported platform), never a state for the user to fix.
 */
export function bundledClaudeBin(): string {
  const requireFromSdk = createRequire(fileURLToPath(import.meta.resolve(SDK)));
  const tried = bundledClaudePackages(process.platform, process.arch, isMusl());
  for (const spec of tried) {
    let path: string;
    try {
      path = requireFromSdk.resolve(spec);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND") continue;
      throw err;
    }
    if (existsSync(path)) return path;
  }
  throw new BundledClaudeMissingError(tried);
}
