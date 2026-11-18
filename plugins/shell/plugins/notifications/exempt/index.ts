import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "endpoints/no-void-fetch-endpoint",
    paths: ["web/internal/toast.ts"],
    kind: "sanctioned",
    reason:
      "Secondary DB persistence of a toast already shown via Shell.Toast.",
  },
  {
    rule: "shell-toast/no-direct-custom-toast",
    paths: ["web/components/notification-view.tsx"],
    kind: "sanctioned",
    reason:
      "useToast's own implementation: the notification view drawn on the toast stack's custom-content path is how every toast is shown — and useToast records it in the notification history.",
  },
] satisfies Exemptions;
