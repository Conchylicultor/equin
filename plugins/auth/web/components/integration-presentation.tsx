import type { ReactNode } from "react";
import { Icon } from "@plugins/ui/plugins/icons/web";
import type { IconRef } from "@plugins/ui/plugins/icons/core";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import {
  ResourceErrorInline,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { IntegrationStatus } from "../slots";

/** An integration's status badge: a spinner while unknown, the error control on a failed read. */
export function IntegrationStatusBadge({
  result,
}: {
  result: ResourceResult<IntegrationStatus>;
}) {
  switch (result.status) {
    case "loading":
      return <Loading variant="spinner" />;
    case "error":
      return (
        <ResourceErrorInline
          variant="icon"
          subject="the status"
          error={result.error}
          refetch={result.refetch}
        />
      );
    case "ready":
      return <Badge variant={result.data.tone}>{result.data.label}</Badge>;
  }
}

/** The top of a provider pane: its icon, name, service and status, and what it unlocks. */
export function IntegrationHeader({
  icon,
  name,
  service,
  description,
  status,
}: {
  icon: IconRef;
  name: string;
  service: string;
  description: string | undefined;
  status: ReactNode;
}) {
  return (
    <Stack gap="sm">
      <Stack direction="row" gap="md" align="center">
        <Icon icon={icon} className={cn("size-8", rigidClass())} />
        <Fill>
          <Text as="h1" variant="heading">
            {name}
          </Text>
          {service !== name ? (
            <Text as="div" variant="caption" tone="muted">
              {service}
            </Text>
          ) : null}
        </Fill>
        <div className={rigidClass()}>{status}</div>
      </Stack>
      {description ? (
        <Text as="p" variant="body" tone="muted">
          {description}
        </Text>
      ) : null}
    </Stack>
  );
}
