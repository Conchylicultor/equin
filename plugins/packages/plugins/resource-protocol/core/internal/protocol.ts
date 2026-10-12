// The live-resource wire protocol's FAILURE vocabulary — one definition both
// ends compile against. The resource runtime (per-worktree server and central)
// sends these frames and bodies; the live-state client reads them. A leaf on
// purpose: the runtime barrel pulls `node:crypto`, so the browser cannot import
// it, and the runtime must not import the live-state client. The frames
// themselves (`SubErrorFrame` included) are declared in `./frames`.

import { CONTRACT_VERDICTS, SUB_ERROR_REASONS } from "./frames";

/**
 * Why a subscription (or its HTTP read) was refused.
 *
 * - `unknown-key` — no resource is registered under the key.
 * - `unauthorized` — the resource's `authorize` seam refused it.
 * - `loader-failed` — the loader threw: a server-side failure.
 * - `contract-mismatch` — the params do not match the resource's declaration
 *   (a required param missing, an unknown one, a non-canonical encoding). The
 *   read is refused before it registers, so no push reruns it.
 * - `refused` — the loader threw a `ResourceRefusal`: the params are well
 *   formed, but the question cannot be answered as asked (an unknown id, an
 *   empty range). Expected and caller-caused — never a server fault, never
 *   reported — and it carries a `code` the resource declares (its
 *   `refusals`) and a user-readable message.
 */
export type SubErrorReason = (typeof SUB_ERROR_REASONS)[number];

/**
 * Whose fault a contract mismatch is, judged from the build the client says it
 * runs against the build the server serves (`contractVerdict`):
 *
 * - `skew` — the tab runs a different bundle than the server: it is out of date,
 *   and a reload fixes it. Expected after every deploy that changes a contract.
 * - `same-build` — both run the same bundle: the client's own encoding fails
 *   the server's decode. A real bug.
 * - `unknown` — one side cannot say (a dev bundle, no served graph, central).
 */
export type ContractVerdict = (typeof CONTRACT_VERDICTS)[number];

/**
 * The JSON body of a failed `GET /api/resources/:key` (404 unknown key, 409
 * contract mismatch, 422 refused — `code` its declared code, `detail` its
 * message —, 500 loader failure), so the client's error carries a typed
 * reason instead of a bare status.
 */
export interface ResourceHttpErrorBody {
  reason: SubErrorReason;
  verdict?: ContractVerdict;
  /** On `refused`: the refusal's declared code. */
  code?: string;
  detail?: string;
}

/**
 * The request header an HTTP resource read names the client's build graph in —
 * the HTTP twin of a `sub` frame's `build` field.
 */
export const BUILD_GRAPH_HEADER = "x-singularity-build-graph";

/** The build a bundle names when it was not built with a graph hash (a dev server). */
export const DEV_BUILD = "dev";

/**
 * The params a subscription named do not match the resource's declaration.
 * Thrown by the params DECODE paths (a subscription's wire params), never by a
 * declaration or an encode — those are programmer errors and stay plain
 * `Error`s that crash loudly. The runtime turns this into `contract-mismatch`.
 */
export class ResourceContractError extends Error {
  constructor(
    public readonly key: string,
    public readonly detail: string,
  ) {
    super(detail);
    this.name = "ResourceContractError";
  }
}

/**
 * An EXPECTED, caller-caused refusal a loader throws: the params are well
 * formed, but the question cannot be answered as asked (a file that is not
 * there, a metric id no source contributes, an interval that ends before it
 * starts). `code` says which refusal it is — one of the codes the resource
 * declares (a `liveValue`'s `refusals`), so a reader can branch on it — and
 * `message` is written for the reader. The runtime sends both — `refused` on
 * the HTTP read (422, `code` + `detail`) and the `sub-error` frame (`code` +
 * `message`) — and does NOT report it as a server failure. A code the
 * resource does not declare is a server bug: the runtime turns it into
 * `loader-failed`, reported, like anything else a loader throws. Thrown
 * through a declaration's typed `refuse(code, message)`, or subclassed for a
 * domain's refusals (`MetricQueryError`).
 */
export class ResourceRefusal extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    if (code === "") {
      throw new Error(`ResourceRefusal: an empty code (message: ${message})`);
    }
    this.name = "ResourceRefusal";
  }
}

/**
 * Judge a contract mismatch: `clientBuild` is the graph the client said it runs
 * (absent from a bundle that predates the field), `serverGraph` the graph this
 * server serves (`null` when unknown).
 *
 * | client build              | verdict      |
 * |---------------------------|--------------|
 * | absent (pre-feature)      | `skew`       |
 * | `"dev"`, or server unknown| `unknown`    |
 * | differs from server       | `skew`       |
 * | equal                     | `same-build` |
 *
 * An absent build is skew because only a bundle older than this protocol sends
 * none — which is exactly the tab that is out of date.
 */
export function contractVerdict(
  clientBuild: string | undefined,
  serverGraph: string | null,
): ContractVerdict {
  if (clientBuild === undefined) return "skew";
  if (clientBuild === DEV_BUILD || serverGraph === null) return "unknown";
  return clientBuild === serverGraph ? "same-build" : "skew";
}

const REASONS: ReadonlySet<string> = new Set<SubErrorReason>(SUB_ERROR_REASONS);
const VERDICTS: ReadonlySet<string> = new Set<ContractVerdict>(
  CONTRACT_VERDICTS,
);

/**
 * Read a failed HTTP read's body as a `ResourceHttpErrorBody`, or `undefined`
 * when it is not one (a proxy's HTML error page, an older server's plain text).
 */
export function parseResourceHttpErrorBody(
  raw: unknown,
): ResourceHttpErrorBody | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { reason, verdict, code, detail } = raw as Record<string, unknown>;
  if (typeof reason !== "string" || !REASONS.has(reason)) return undefined;
  return {
    reason: reason as SubErrorReason,
    ...(typeof verdict === "string" && VERDICTS.has(verdict)
      ? { verdict: verdict as ContractVerdict }
      : {}),
    ...(typeof code === "string" ? { code } : {}),
    ...(typeof detail === "string" ? { detail } : {}),
  };
}

/** The content type of a BYTES resource's HTTP read (a `liveValue` declared `bytes: true`). */
export const RESOURCE_BYTES_CONTENT_TYPE = "application/octet-stream";

/**
 * The response headers a BYTES read's envelope rides in. A JSON read wraps its
 * value as `{ value, version, epoch, watermark? }`; a bytes read's body IS the
 * value, so the rest of that envelope — what the client's version guard
 * (stale-drop, cross-boot) needs — moves here.
 */
export const RESOURCE_BYTES_HEADERS = {
  version: "x-resource-version",
  epoch: "x-resource-epoch",
  watermark: "x-resource-watermark",
} as const;

/** The envelope of a resource HTTP read, without its value. */
export interface ResourceReadEnvelope {
  /** The tuple's server version (a per-boot counter) the value is no newer than. */
  version: number;
  /** The server boot the version belongs to. */
  epoch: string;
  /** The commit watermark the value reflects, when the read captured one. */
  watermark?: string;
}

/** A bytes read's envelope as its response headers (see {@link RESOURCE_BYTES_HEADERS}). */
export function resourceBytesHeaders(
  envelope: ResourceReadEnvelope,
): Record<string, string> {
  return {
    "content-type": RESOURCE_BYTES_CONTENT_TYPE,
    [RESOURCE_BYTES_HEADERS.version]: String(envelope.version),
    [RESOURCE_BYTES_HEADERS.epoch]: envelope.epoch,
    ...(envelope.watermark !== undefined
      ? { [RESOURCE_BYTES_HEADERS.watermark]: envelope.watermark }
      : {}),
  };
}

/**
 * Read a bytes read's envelope back from its response headers. Throws when
 * the response is not one — another content type (a server serving the key as
 * JSON: the two ends declare it differently), or a missing / malformed
 * version or epoch — since a value with no version cannot pass the guard.
 */
export function parseResourceBytesHeaders(
  key: string,
  headers: { get(name: string): string | null },
): ResourceReadEnvelope {
  const contentType = headers.get("content-type");
  if (contentType?.split(";")[0]?.trim() !== RESOURCE_BYTES_CONTENT_TYPE) {
    throw new Error(
      `resource "${key}": a bytes read answered content-type ` +
        `${JSON.stringify(contentType)}, not ${RESOURCE_BYTES_CONTENT_TYPE}.`,
    );
  }
  const rawVersion = headers.get(RESOURCE_BYTES_HEADERS.version);
  const version =
    rawVersion !== null && /^\d+$/.test(rawVersion) ? Number(rawVersion) : NaN;
  const epoch = headers.get(RESOURCE_BYTES_HEADERS.epoch);
  if (!Number.isSafeInteger(version) || !epoch) {
    throw new Error(
      `resource "${key}": a bytes read carries no valid envelope ` +
        `(${RESOURCE_BYTES_HEADERS.version}: ${JSON.stringify(rawVersion)}, ` +
        `${RESOURCE_BYTES_HEADERS.epoch}: ${JSON.stringify(epoch)}).`,
    );
  }
  const watermark = headers.get(RESOURCE_BYTES_HEADERS.watermark);
  return { version, epoch, ...(watermark !== null ? { watermark } : {}) };
}
