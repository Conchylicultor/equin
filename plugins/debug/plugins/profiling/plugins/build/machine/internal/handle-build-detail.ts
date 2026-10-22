import { readFileSync } from "node:fs";
import { HttpError } from "@plugins/infra/plugins/endpoints/core";
import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { worktreeArtifacts } from "@plugins/infra/plugins/paths/server";
import {
  asNamespace,
  isNamespace,
} from "@plugins/infra/plugins/namespace/core";
import { getBuildRunProfileByWorktree } from "../../shared/endpoints";

interface BuildProfile {
  spans: Array<{
    id: string;
    phase: string;
    label: string;
    startMs: number;
    durationMs: number;
    maxRssBytes?: number;
  }>;
  totalDurationMs: number;
}

// Defensive: the build id comes from a URL param and is joined into a filesystem
// path. The worktree is guarded by the namespace grammar instead, which is both
// stricter and the rule the gateway itself applies.
function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "");
}

function readProfile(worktree: string, buildId: string): BuildProfile | null {
  const id = sanitize(buildId);
  if (!isNamespace(worktree) || !id) return null;
  const path = worktreeArtifacts.buildProfile(asNamespace(worktree), id);
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as BuildProfile;
  } catch (err) {
    if (
      (err as NodeJS.ErrnoException).code !== "ENOENT" &&
      !(err instanceof SyntaxError)
    )
      throw err;
    return null;
  }
}

export const handleBuildDetail = implementMachine(
  getBuildRunProfileByWorktree,
  ({ params }) => {
    const { worktree, buildId } = params;
    if (!worktree || !buildId) throw new HttpError(400, "Missing params");
    const profile = readProfile(worktree, buildId);
    return {
      spans: profile?.spans ?? [],
      totalMs: profile?.totalDurationMs ?? 0,
    };
  },
);
