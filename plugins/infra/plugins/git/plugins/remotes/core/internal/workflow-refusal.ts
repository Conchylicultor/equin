/**
 * GitHub's refusal of a push that changes a workflow file, read from git's
 * output — or `null` when the output holds none.
 *
 * GitHub refuses an HTTPS push whose commits add, edit or delete a file under
 * `.github/workflows/` unless the pushing credential may change workflows: an
 * OAuth app's token (the `gh` CLI's login) or a classic personal access token
 * needs the `workflow` scope, a GitHub App the `workflows` permission. Workflow
 * files are code GitHub runs with the repository's secrets, so it keeps them
 * behind a grant of their own. An SSH key is never refused this way.
 *
 * It is its own arm, not a `denied`: the remote accepted us as a writer (the
 * write probe says so, and every other ref of the push would land) and refused
 * one kind of change, which only the user can allow, in a browser. A push
 * reads it to land the work on local `main` anyway and say what to grant.
 *
 * Read from the per-ref status git prints for a rejected ref, verbatim:
 *
 *   ! [remote rejected] main -> main (refusing to allow an OAuth App to create
 *   or update workflow `.github/workflows/x.yml` without `workflow` scope)
 */
export interface WorkflowRefusal {
  /** Which credential GitHub refused. */
  credential: "oauth-app" | "personal-access-token" | "github-app" | "other";
  /** The workflow files GitHub named (one per rejected ref, deduplicated). */
  files: string[];
}

const REFUSAL =
  /refusing to allow (?:an? )?(.+?) to create or update workflow `([^`]+)` without `workflows?` (?:scope|permission)/g;

const CREDENTIALS: Record<string, WorkflowRefusal["credential"]> = {
  "oauth app": "oauth-app",
  "personal access token": "personal-access-token",
  "github app": "github-app",
};

export function workflowRefusal(output: string): WorkflowRefusal | null {
  const files = new Set<string>();
  let credential: WorkflowRefusal["credential"] | null = null;
  for (const m of output.matchAll(REFUSAL)) {
    credential ??= CREDENTIALS[m[1]!.toLowerCase()] ?? "other";
    files.add(m[2]!);
  }
  return credential === null ? null : { credential, files: [...files] };
}

/**
 * What the user does to allow it, for the credential GitHub refused — the one
 * step no agent can take for them (it is a consent in their browser).
 */
export function describeWorkflowRefusal(r: WorkflowRefusal): string {
  const grant =
    r.credential === "oauth-app"
      ? "Grant it once (opens your browser): gh auth refresh -h github.com -s workflow"
      : r.credential === "personal-access-token"
        ? "Grant it once: give the personal access token git uses the `workflow` scope (or the Workflows permission, for a fine-grained token)"
        : r.credential === "github-app"
          ? "Grant it once: give the GitHub App the Workflows (read and write) permission"
          : "Grant it once: give the credential git pushes with permission to change workflows, or push over SSH";
  return [
    `GitHub refused the change to ${r.files.join(", ")}: the login git pushes with may not change workflow files.`,
    grant,
  ].join("\n");
}
