import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "surface/no-adhoc-surface",
    paths: ["web/components/ui"],
    kind: "sanctioned",
    reason:
      "The shadcn surface-primitive definitions themselves: they open-code the raised/overlay recipe as literal strings (the implementation behind <Surface>/PopoverContent/DropdownMenuContent).",
  },
  {
    rule: "viewport-overlay/no-adhoc-viewport-overlay",
    paths: ["web/components/ui"],
    kind: "sanctioned",
    reason:
      "The shadcn dialog/sheet definitions themselves: they open-code `fixed inset-0` as literal strings on base-ui `*.Popup`/`*.Backdrop` tags, which base-ui portals to the document root.",
  },
  {
    rule: "kept-state/no-raw-text-input",
    paths: ["web/components/ui/textarea.tsx"],
    kind: "sanctioned",
    reason:
      "The Textarea primitive itself: the one <textarea>, whose required `keep` makes every multi-line field decide whether its text survives a reload.",
  },
] satisfies Exemptions;
