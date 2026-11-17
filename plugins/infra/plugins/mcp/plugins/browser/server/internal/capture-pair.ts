import { servedGatewayPort } from "@plugins/infra/plugins/launcher/plugins/gateway-port/core";
import {
  MAIN_WORKTREE_NAME,
  namespaceUrl,
} from "@plugins/infra/plugins/namespace/core";
import type { HostCaptureShot } from "../../shared/protocol";
import { callHostCapturePair } from "./host-client";
import { resolveTarget } from "./target";

/** What to capture: one route of the app, at one viewport and colour scheme. */
export interface CapturePairRequest {
  /** A route of the app (`/agents/…`), captured on main and on this build. */
  route: string;
  width: number;
  height: number;
  colorScheme: "light" | "dark";
}

/** One captured page: PNG bytes and where it ended. */
export interface CapturedPage {
  png: Uint8Array;
  /** Where the page ended (after redirects). */
  url: string;
  httpStatus: number | null;
  /** Loaders still visible at the readiness deadline (captured anyway). */
  stillBusy: string[];
}

export interface CapturedPair {
  before: CapturedPage;
  after: CapturedPage;
  /** How long the capture queued for a browser slot. */
  slotWaitedMs: number;
}

/**
 * This conversation's build has no deploy yet — the "after" has nowhere to be
 * captured from. Never derived from a name (that would capture main twice).
 */
export class UnbuiltCheckoutError extends Error {}

/**
 * Capture `route` on MAIN (the before) and on THIS conversation's own build
 * (the after) at the same viewport and colour scheme, in the conversation's
 * agent-browser session — each in a throwaway page (its tabs untouched), each
 * once ready by the e2e harness's rule (painted, network idle, no loader).
 *
 * Throws `UnbuiltCheckoutError` while the conversation's checkout has no
 * deploy, `HostCannotCaptureError` when the machine's host predates captures,
 * and the host's own message when a page fails (never painted, navigation
 * timed out). Both URLs are resolved here: the host has no database.
 */
export async function capturePair(
  conversationId: string,
  request: CapturePairRequest,
): Promise<CapturedPair> {
  if (!request.route.startsWith("/")) {
    throw new Error(
      `"${request.route}" is not a route — pass the app path, starting with "/" (e.g. "/agents").`,
    );
  }
  const target = await resolveTarget(conversationId);
  if (target.kind === "unbuilt") {
    throw new UnbuiltCheckoutError(
      `This conversation's checkout (${target.checkout}) has no build yet, so there is no "after" to capture. ` +
        "Run `./equin build` first, then call again.",
    );
  }
  const mainOrigin = namespaceUrl(MAIN_WORKTREE_NAME, "", servedGatewayPort());
  const { shots, slotWaitedMs } = await callHostCapturePair({
    conversationId,
    target,
    urls: [`${mainOrigin}${request.route}`, `${target.origin}${request.route}`],
    viewport: { width: request.width, height: request.height },
    colorScheme: request.colorScheme,
  });
  return {
    before: capturedPage(shots[0]),
    after: capturedPage(shots[1]),
    slotWaitedMs,
  };
}

function capturedPage(shot: HostCaptureShot): CapturedPage {
  return {
    png: base64Bytes(shot.png),
    url: shot.url,
    httpStatus: shot.httpStatus,
    stillBusy: shot.stillBusy,
  };
}

/** Decode base64 with web APIs only (`server/` is portable: no `Buffer`). */
function base64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
