import type { EndpointDef, MachineEndpointDef } from "./define-endpoint";
import { extractPath, interpolatePath } from "./route-params";

/** A GET endpoint — what a document links to. */
type LinkedEndpoint<TParams> =
  | EndpointDef<`GET ${string}`, TParams, unknown, unknown, unknown>
  | MachineEndpointDef<`GET ${string}`, TParams, unknown, unknown, unknown>;

/**
 * A markdown link to what `endpoint` serves for `params`, for a document that
 * persists the address (an attachment in a task description):
 * `[text](/api/…)`, or `![text](/api/…)` with `image`. The answer is markdown
 * TEXT, read back by the markdown sinks — which load such an address over
 * their subtree's transport or show it as text — never a `src`: an element
 * loads an `AssetPath` (`assetPath`). `text` is written as given; escaping it
 * is the caller's.
 */
export function documentLink<TParams>(
  endpoint: LinkedEndpoint<TParams>,
  params: TParams,
  link: { text: string; image?: boolean },
): string {
  const address = interpolatePath(
    extractPath(endpoint.route),
    (params ?? {}) as Record<string, string>,
  );
  return `${link.image === true ? "!" : ""}[${link.text}](${address})`;
}
