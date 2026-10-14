import type { BadgeVariant } from "@plugins/primitives/plugins/css/plugins/badge/web";

// Trigger-kind → badge color for the list's Trigger column. An OPEN vocabulary
// (any plugin may mint a trigger kind), so this is a best-effort tint with a
// muted fallback — it never gates which kinds render, only how they look.
const KIND_VARIANT: Record<string, BadgeVariant> = {
  stall: "destructive",
  "op-time": "destructive",
  loader: "warning",
  http: "info",
  db: "warning",
  push: "info",
  flush: "info",
  sub: "info",
  job: "muted",
  boot: "warning",
  element: "success",
  "page-load": "success",
  update: "success",
  confirm: "success",
};

export function triggerVariant(kind: string): BadgeVariant {
  return KIND_VARIANT[kind] ?? "muted";
}
