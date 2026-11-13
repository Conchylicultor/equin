/**
 * The boot snapshot request the SPA shell's head starts, handed to the boot
 * task. The head script (rendered by the server half's DocumentHead.Fragment)
 * issues the GET while the HTML is still being parsed — in parallel with the
 * module downloads — and parks it on the page's global object under this name;
 * the boot task takes it (once) instead of issuing its own request, so the
 * snapshot no longer waits for the eager tier to download and evaluate.
 */
export const HEAD_REQUEST_GLOBAL = "__equinBootSnapshotRequest";

/** What the head script parks: the in-flight response, and when it was asked for. */
export interface HeadRequest {
  response: Promise<Response>;
  /** `performance.now()` when the head script issued the request. */
  startMs: number;
}
