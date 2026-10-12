import { ZodError } from "zod";
import {
  EndpointError,
  getEndpointErrorMessage,
} from "@plugins/infra/plugins/endpoints/web";
import { ResourceError, type ResourceErrorKind } from "../core";
import {
  ResourceHttpError,
  ResourceStaleReadError,
} from "./resource-http-errors";

/**
 * THE one place a raw read failure becomes a typed `ResourceError`. Every path
 * that can fail a read funnels here — `useResource`'s `q.error` and the
 * `NotificationsClient`'s failing-resource bookkeeping — so a surface and the
 * health report can never disagree about what kind of failure a read hit.
 *
 * Memoized per raw error: React Query hands every observer of a query the SAME
 * error object, so they all get the same `ResourceError` (a stable identity
 * for memoized results, and one report per failure, not per hook).
 */
const cache = new WeakMap<object, ResourceError>();

export function toResourceError(raw: unknown): ResourceError {
  if (raw instanceof ResourceError) return raw;
  if (typeof raw === "object" && raw !== null) {
    const hit = cache.get(raw);
    if (hit !== undefined) return hit;
    const made = classify(raw);
    cache.set(raw, made);
    return made;
  }
  return classify(raw);
}

function classify(raw: unknown): ResourceError {
  const { kind, message, code } = kindOf(raw);
  return new ResourceError(kind, message, raw, code);
}

const OUTDATED = {
  kind: "client-outdated",
  message: "This tab is out of date — reload to load this.",
} as const;

function kindOf(raw: unknown): {
  kind: ResourceErrorKind;
  message: string;
  code?: string;
} {
  if (raw instanceof ResourceHttpError) {
    // A refusal is the server's answer, written for the reader: its message
    // IS the error's, and its code what a surface branches on.
    // `fetchOverHttp` turns a refusal whose code the read does not declare
    // into a `contract-mismatch`, so a code-less one here is that same
    // mismatch, built some other way: the tab does not speak the answer.
    if (raw.reason === "refused") {
      if (raw.code === undefined) return OUTDATED;
      return {
        kind: "refused",
        message: raw.detail ?? raw.message,
        code: raw.code,
      };
    }
    // A contract refusal means this bundle does not speak the resource's
    // contract. Unless the server can prove both run the SAME build (then the
    // client's own encoding is a real bug — reloading would not help), the
    // tab is out of date: a dev bundle's `unknown` verdict is fixed by a
    // reload too.
    if (raw.reason === "contract-mismatch" || raw.reason === "unknown-key") {
      if (raw.verdict !== "same-build") return OUTDATED;
      return raw.reason === "unknown-key"
        ? { kind: "not-found", message: raw.message }
        : { kind: "loader-failed", message: raw.message };
    }
    if (raw.status === 404) return { kind: "not-found", message: raw.message };
    return { kind: "loader-failed", message: raw.message };
  }
  // A typed endpoint read (`useEndpointResource`) that got an HTTP answer:
  // the server's own message.
  if (raw instanceof EndpointError) {
    const message = getEndpointErrorMessage(raw);
    if (raw.status === 404) return { kind: "not-found", message };
    return { kind: "loader-failed", message };
  }
  // A value this bundle's schema rejects: the server's shape moved under an
  // open tab (or a real schema bug — the cause says which). Reload is the fix.
  if (raw instanceof ZodError) return OUTDATED;
  // `fetch` rejects with a `TypeError` when the request never got an answer.
  if (raw instanceof TypeError) {
    return { kind: "transport", message: `Network error: ${raw.message}` };
  }
  // A body the version guard dropped as older than what the tab holds: a race
  // a retry (or the next push) settles, not a server failure.
  if (raw instanceof ResourceStaleReadError) {
    return { kind: "transport", message: raw.message };
  }
  if (raw instanceof Error)
    return { kind: "loader-failed", message: raw.message };
  return { kind: "loader-failed", message: String(raw) };
}
