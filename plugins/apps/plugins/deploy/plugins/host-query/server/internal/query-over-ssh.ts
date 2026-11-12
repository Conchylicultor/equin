import type { z } from "zod";
import type {
  SshRunResult,
  SshTarget,
} from "@plugins/infra/plugins/ssh/server";
import { HOST_ONLY_PREFIX } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/host-only/core";
import { LOOPBACK_HOST } from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import { CURL_EXIT, type HostQueryFailure } from "../../core";

/** curl's own deadline for the answer, well under the SSH session's. */
export const CURL_MAX_SECONDS = 10;
/** The whole SSH attempt: connect + curl's deadline + slack. */
export const SSH_TIMEOUT_MS = 20_000;

/** curl's `-w`: the HTTP status on its own last line, after the body. */
const STATUS_LINE_FORMAT = "\\n%{http_code}";

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
  opts: HostQueryOptions = {},
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
  const { maxAnswerBytes } = opts;
  if (
    maxAnswerBytes !== undefined &&
    !(Number.isInteger(maxAnswerBytes) && maxAnswerBytes > 0)
  ) {
    throw new Error(
      `hostOnlyQueryOverSsh: maxAnswerBytes must be a positive integer, got ${maxAnswerBytes}`,
    );
  }
  return [
    "curl",
    // No `-f`: an HTTP error is read from the status line `-w` appends, so a
    // 404 (the site's release does not serve the route) is told apart from
    // every other error. `\n` is expanded by curl itself.
    "-sS",
    "-w",
    `'${STATUS_LINE_FORMAT}'`,
    "-m",
    String(CURL_MAX_SECONDS),
    // curl stops past the cap (exit 63) when the box declares the size up
    // front; a chunked answer is bounded only by `-m` here, so the check in
    // `mapSshAnswer` is the guarantee and this the early stop.
    ...(maxAnswerBytes === undefined
      ? []
      : ["--max-filesize", String(maxAnswerBytes)]),
    // Quoted for the remote shell `sshRun` joins this into: `&` and `?`
    // would otherwise background the command or glob.
    `'http://${LOOPBACK_HOST}:${loopbackPort}${path}'`,
  ];
}

/**
 * How a read bounds what it takes from the box. `maxAnswerBytes`: an answer
 * longer than this is refused (`unreadable-answer`) before it is parsed — set
 * it whenever the answer carries content strangers wrote.
 */
export interface HostQueryOptions {
  maxAnswerBytes?: number;
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** What the SSH layer answered, parsed with `schema` or mapped onto a failure. */
export function mapSshAnswer<T>(
  result: SshRunResult,
  path: string,
  schema: z.ZodType<T>,
  opts: HostQueryOptions = {},
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

  // The status line `-w` appends is always the last line; the body is
  // everything before it.
  const cut = result.stdout.lastIndexOf("\n");
  const status = Number(result.stdout.slice(cut + 1));
  if (cut < 0 || !Number.isInteger(status) || status === 0) {
    return {
      kind: "unreadable-answer",
      detail: `No HTTP status line after the answer: ${result.stdout.slice(-ANSWER_HEAD_CHARS)}`,
    };
  }
  return mapHttpResponse(
    { status, body: result.stdout.slice(0, cut) },
    path,
    schema,
    opts,
  );
}

/**
 * One HTTP answer from the box, whichever way it was asked: 404 is the route
 * the site's release does not serve, any other status >= 400 a failed request
 * (curl's 22), else the body parsed.
 */
function mapHttpResponse<T>(
  { status, body }: { status: number; body: string },
  path: string,
  schema: z.ZodType<T>,
  opts: HostQueryOptions,
): { kind: "answer"; value: T } | HostQueryFailure {
  if (status === 404) return { kind: "route-missing", path };
  if (status >= 400) {
    return {
      kind: "request-failed",
      exitCode: CURL_EXIT.httpError,
      stderr: `HTTP ${status}: ${body.slice(0, ANSWER_HEAD_CHARS)}`,
    };
  }
  return parseAnswerBody(body, schema, opts);
}

/**
 * An answer's body — refused unread when over `opts.maxAnswerBytes`, else
 * parsed as JSON and then with `schema` — or named unreadable.
 */
export function parseAnswerBody<T>(
  body: string,
  schema: z.ZodType<T>,
  opts: HostQueryOptions = {},
): { kind: "answer"; value: T } | HostQueryFailure {
  if (
    opts.maxAnswerBytes !== undefined &&
    utf8Length(body) > opts.maxAnswerBytes
  ) {
    return {
      kind: "unreadable-answer",
      detail: `The answer is over ${opts.maxAnswerBytes} bytes; it was not read.`,
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return {
      kind: "unreadable-answer",
      detail: `Not JSON (${err.message}): ${body.slice(0, ANSWER_HEAD_CHARS)}`,
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
  | { kind: "ready"; target: SshTarget; loopbackPort: number }
  // A demo's stand-in: the box is this instance, asked through its own gateway.
  | { kind: "this-instance" };

/** What asking this instance's own gateway answered. */
export type ThisInstanceResponse =
  | { kind: "response"; status: number; body: string }
  | { kind: "unreachable"; message: string };

/** The two effects a query needs, injected so the mapping is testable without a box. */
export interface QueryDeps {
  resolveDeployment: (deploymentId: string) => Promise<DeploymentTarget>;
  sshRun: (target: SshTarget, argv: string[]) => Promise<SshRunResult>;
  /** GET `path` on this instance's own gateway (the `this-instance` arm). */
  fetchThisInstance: (path: string) => Promise<ThisInstanceResponse>;
}

/** The `this-instance` arm: one gateway hop, mapped like the curl's answer. */
export function mapThisInstanceAnswer<T>(
  response: ThisInstanceResponse,
  path: string,
  schema: z.ZodType<T>,
  opts: HostQueryOptions = {},
): { kind: "answer"; value: T } | HostQueryFailure {
  if (response.kind === "unreachable") {
    return {
      kind: "request-failed",
      exitCode: CURL_EXIT.couldNotConnect,
      stderr: response.message,
    };
  }
  return mapHttpResponse(response, path, schema, opts);
}

/** Throws unless `path` is a host-only route the SSH arm would also accept. */
function assertHostOnlyPath(path: string): void {
  hostQueryCurlArgv(0, path);
}

export async function queryOverSsh<T>(
  deps: QueryDeps,
  deploymentId: string,
  path: string,
  schema: z.ZodType<T>,
  opts: HostQueryOptions = {},
): Promise<HostQueryAnswer<T>> {
  const resolved = await deps.resolveDeployment(deploymentId);
  if (resolved.kind === "this-instance") {
    assertHostOnlyPath(path);
    return mapThisInstanceAnswer(
      await deps.fetchThisInstance(path),
      path,
      schema,
      opts,
    );
  }
  if (resolved.kind !== "ready") return resolved;
  const argv = hostQueryCurlArgv(resolved.loopbackPort, path, opts);
  return mapSshAnswer(
    await deps.sshRun(resolved.target, argv),
    path,
    schema,
    opts,
  );
}
