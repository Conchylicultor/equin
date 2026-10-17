import type { ReactElement } from "react";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import type { OwnedNamespaceInfo } from "../../shared/endpoints";

/**
 * The inventory of what a composition is serving, as the delete confirmation
 * shows it: one line per address, saying where it came from and whether real
 * data sits behind it.
 *
 * Every line is spelled out rather than summarised into a count, because a count
 * is exactly what the person confirming cannot check: "3 namespaces" does not
 * say that one of them is the one on main holding their content.
 *
 * A plain list rather than a DataView on purpose — this is transient dialog
 * chrome, read once and dismissed, with nothing to search, sort or group.
 */
export function OwnedNamespacesList({
  namespaces,
}: {
  namespaces: OwnedNamespaceInfo[];
}): ReactElement {
  return (
    <Stack gap="xs">
      {namespaces.map((ns) => (
        <Stack key={ns.namespace} direction="row" align="center" gap="xs">
          <Badge mono variant="muted" tooltip={ns.url}>
            {ns.host}
          </Badge>
          <Text variant="caption" tone="muted">
            {originOf(ns)} —{" "}
            {ns.hasDatabase ? "its database is deleted too" : "no database"}
          </Text>
        </Stack>
      ))}
    </Stack>
  );
}

/**
 * Where this address came from. The unknown arm is worded as the unknown it is:
 * a marker written before the checkout field existed genuinely does not say
 * which checkout built it, and naming main would be a guess shown to someone
 * about to destroy data.
 */
function originOf(ns: OwnedNamespaceInfo): string {
  switch (ns.builtBy.kind) {
    case "main":
      return "built from the main checkout";
    case "checkout":
      return `built from checkout ${ns.builtBy.checkout}`;
    case "unknown":
      return "built by a checkout it does not record";
  }
}
