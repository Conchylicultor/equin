import { registerNodeExtension } from "@plugins/primitives/plugins/text-editor/web";
import { GO_MARKER_RE, goMarkerWebNode } from "./marker-node";
import { goPickWebNode } from "./pick-node";
import { GO_PICK_RE } from "./parse-go";

// Side-effect: a `<go>` / `</go>` arriving in any TextEditor (the ✎ Go insert,
// a paste, a restored draft) becomes its marker node, and a picked line's
// `- [x] ` its ✓.
registerNodeExtension({
  id: "go-marker",
  node: goMarkerWebNode,
  pattern: GO_MARKER_RE,
});
registerNodeExtension({
  id: "go-pick",
  node: goPickWebNode,
  pattern: GO_PICK_RE,
});
