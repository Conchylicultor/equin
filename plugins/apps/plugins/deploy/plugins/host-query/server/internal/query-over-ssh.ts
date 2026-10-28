import type { z } from "zod";
import type {
  SshRunResult,
  SshTarget,
} from "@plugins/infra/plugins/ssh/server";
import { HOST_ONLY_PREFIX } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/host-only/core";
import { LOOPBACK_HOST } from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import type { HostQueryFailure } from "../../core";

/** curl's own deadline for the answer, well under the SSH session's. */
export const CURL_MAX_SECONDS = 10;
/** The whole SSH attempt: connect + curl's deadline + slack. */
export const SSH_TIMEOUT_MS = 20_000;

/** How much of an unparseable answer is echoed back to the UI. */
const ANSWER_HEAD_CHARS = 300;

/**
 * What a path may hold. `sshRun` joins its argv with spaces into one remote
 * shell command (OpenSSH has no argv-preserving exec), so the URL travels
 * single-quoted — which makes `?` and `&` inert — and anything that could end
 * or escape the quotes (a `'`, a backslash, whitespace, …) is refused rather
 * than escaped. Callers encode their query (base64url, `URLSearchParams`) —
 * both stay inside this alphabet.
 */
const SHELL_SAFE_PATH = /^[A-Za-z0-9/_.~?=&%+-]+$/;

/** What asking one deployment's box answered. */
export type HostQueryAnswer<T> =
  { kind: "answer"; value: T } | HostQueryFailure | { kind: "not-found" };

/**
 * The command run on the box. It targets the install's GATEWAY on its loopback
 * port, never the backend socket: `hostOnly` requires exactly the one proxy hop
 * the gateway appends, so this is the only path a host-only route answers on.
 *
 * Throws on a path outside the host-only prefix (Caddy does not refuse it
 * publicly, so it is not a host-only route) or one the remote shell would read.
 */
export function hostQueryCurlArgv(
  loopbackPort: number,
  path: string,
): string[] {
  if (!path.startsWith(HOST_ONLY_PREFIX)) {
    throw new Error(
      `hostOnlyQueryOverSsh: ${path} is outside ${HOST_ONLY_PREFIX} — only host-only routes are read over SSH`,
    );
  }
  if (!SHELL_SAFE_PATH.test(path)) {
    throw new Error(
      `hostOnlyQueryOverSsh: ${JSON.stringify(path)} holds characters the remote shell would read — encode the query`,
    );
  }
  return [
    "curl",
    "-fsS",
    "-m",
    String(CURL_MAX_SECONDS),
    // Quoted for the remote shell `sshRun` joins this into: `&` and `?`
    // would otherwise background the command or glob.
    `'http://${LOOPBACK_HOST}:${loopbackPort}${path}'`,
  ];
}

/** What the SSH layer answered, parsed with `schema` or mapped onto a failure. */
export function mapSshAnswer<T>(
  result: SshRunResult,
  schema: z.ZodType<T>,
): { kind: "answer"; value: T } | HostQueryFailure {
  if (!result.ok) {
    // `command-failed` means SSH connected and authenticated and the remote
    // command — curl — exited non-zero. That is a failure of the request, not
    // of SSH, and curl's exit code says which (see CURL_EXIT).
    if (result.kind === "command-failed") {
      return {
        kind: "request-failed",
        exitCode: result.exitCode,
        stderr: result.stderr,
      };
    }
    return {
      kind: "ssh-failed",
      failure: result.kind,
      message: result.message,
      stderr: result.stderr,
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(result.stdout);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return {
      kind: "unreadable-answer",
      detail: `Not JSON (${err.message}): ${result.stdout.slice(0, ANSWER_HEAD_CHARS)}`,
    };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return {
      kind: "unreadable-answer",
      detail: `Not the expected answer: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    };
  }
  return { kind: "answer", value: parsed.data };
}

/** Where a deployment is, and how to reach its box — as far as it resolved. */
export type DeploymentTarget =
  | { kind: "not-found" }
  | { kind: "no-ssh-key" }
  | { kind: "unverified" }
  | { kind: "ready"; target: SshTarget; loopbackPort: number };

/** The two effects a query needs, injected so the mapping is testable without a box. */
export interface QueryDeps {
  resolveDeployment: (deploymentId: string) => Promise<DeploymentTarget>;
  sshRun: (target: SshTarget, argv: string[]) => Promise<SshRunResult>;
}

export async function queryOverSsh<T>(
  deps: QueryDeps,
  deploymentId: string,
  path: string,
  schema: z.ZodType<T>,
): Promise<HostQueryAnswer<T>> {
  const resolved = await deps.resolveDeployment(deploymentId);
  if (resolved.kind !== "ready") return resolved;
  const argv = hostQueryCurlArgv(resolved.loopbackPort, path);
  return mapSshAnswer(await deps.sshRun(resolved.target, argv), schema);
}
