import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import {
  browserFileMove,
  computerFileMove,
  type BrowsableFileSystem,
} from "../../core";

/**
 * The move of `fs` (paths of that system into one of its folders) — one
 * mutation shape whichever system: `unavailable` where this host cannot run
 * it (the computer's disk in the in-browser demo). Every system's mutation is
 * declared every render (hooks cannot be conditional); only `fs`'s is used.
 */
// The return type is the computer's mutation (`unavailable | available`),
// which the browser's always-available one is lifted into.
export function useFileMove(fs: BrowsableFileSystem) {
  const computer = useEndpointMutation(computerFileMove);
  const browser = useEndpointMutation(browserFileMove);
  switch (fs) {
    case "computer":
      return computer;
    case "browser":
      return { kind: "available" as const, ...browser };
  }
}
