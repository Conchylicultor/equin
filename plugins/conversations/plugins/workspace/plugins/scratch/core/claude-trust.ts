import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CLAUDE_USER_CONFIG } from "@plugins/infra/plugins/paths/core";

// Claude Code's user config: the per-directory trust answers live in its
// `projects[<dir>].hasTrustDialogAccepted`, and a directory inherits trust from
// any trusted ancestor (measured 2026-10-14: an interactive session in a child
// of a trusted dir shows no "Quick safety check" dialog; in an untrusted dir it
// does). A worktree inherits the repo's trust; a scratch workspace inherits
// the trust its root is given when a backend boots (`../server`).

type ClaudeConfig = { projects?: Record<string, Record<string, unknown>> };

function parse(text: string, path: string): ClaudeConfig {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `[scratch trust] ${path} is not valid JSON, refusing to touch it: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`[scratch trust] ${path} is not a JSON object`);
  }
  return value as ClaudeConfig;
}

/** Whether `dir` or one of its ancestors is trusted in this config text. */
export function isDirTrusted(
  text: string,
  dir: string,
  path = "config",
): boolean {
  const projects = parse(text, path).projects ?? {};
  for (let d = dir; ; d = dirname(d)) {
    if (projects[d]?.hasTrustDialogAccepted === true) return true;
    if (dirname(d) === d) return false;
  }
}

/**
 * The config text with `dir` trusted — `projects[dir].hasTrustDialogAccepted =
 * true`, every other key untouched — or `unchanged` when `dir` (or an
 * ancestor) already is. Pure. Serialized as Claude Code writes the file
 * (two-space indent, no trailing newline).
 */
export function withDirTrusted(
  text: string,
  dir: string,
  path = "config",
): { kind: "unchanged" } | { kind: "changed"; text: string } {
  if (isDirTrusted(text, dir, path)) return { kind: "unchanged" };
  const config = parse(text, path);
  const projects = config.projects ?? {};
  const next = {
    ...config,
    projects: {
      ...projects,
      [dir]: { ...projects[dir], hasTrustDialogAccepted: true },
    },
  };
  return { kind: "changed", text: JSON.stringify(next, null, 2) };
}

/**
 * Trust `dir` in Claude Code's user config. Idempotent (no write when already
 * trusted). Claude Code processes write this file too, so the write is atomic
 * (a temp file beside it, renamed over it, keeping its mode) and the file is
 * re-read immediately before it, so a concurrent write since the first read is
 * not undone. Throws on an unparseable file.
 */
export function ensureDirTrusted(dir: string, path = CLAUDE_USER_CONFIG): void {
  if (
    withDirTrusted(readFileSync(path, "utf8"), dir, path).kind === "unchanged"
  ) {
    return;
  }
  // Re-read right before writing: the transform applies to the newest text.
  const fresh = withDirTrusted(readFileSync(path, "utf8"), dir, path);
  if (fresh.kind === "unchanged") return;
  const tmp = `${path}.singularity-${process.pid}.tmp`;
  writeFileSync(tmp, fresh.text, { mode: statSync(path).mode });
  renameSync(tmp, path);
}

/**
 * Throws unless `dir` is trusted — a session started there would otherwise
 * sit at Claude Code's trust dialog forever, with nothing reporting it.
 */
export function assertDirTrusted(dir: string, path = CLAUDE_USER_CONFIG): void {
  if (!isDirTrusted(readFileSync(path, "utf8"), dir, path)) {
    throw new Error(
      `${dir} is not trusted in ${path}, so a Claude Code session there stops at its trust dialog. ` +
        `The conversations/workspace/scratch plugin trusts the scratch root when a backend boots: restart the backend, and see its boot log if this persists.`,
    );
  }
}
