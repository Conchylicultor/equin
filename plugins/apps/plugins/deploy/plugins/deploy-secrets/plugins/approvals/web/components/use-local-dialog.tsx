import type { ReactElement } from "react";
import {
  Button,
  DialogDescription,
  DialogTitle,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  getEndpointErrorMessage,
  useEndpointMutation,
} from "@plugins/infra/plugins/endpoints/web";
import { adoptLocalDeploySecretValue } from "../../core";
import type { SecretItem } from "../internal/items";

/**
 * Confirm reusing this computer's value of a secret: shows which value would
 * be used — its preview (masked for a credential), never the value, which the
 * server reads and stores itself — and the source's caution when it has one.
 *
 * Like Set value, using it does NOT approve it: the row turns `new` (or
 * `value changed`) and Approve is a second, deliberate click.
 */
export function UseLocalValueDialog({
  item,
  preview,
  fingerprint,
  caution,
  close,
}: {
  item: SecretItem;
  preview: string;
  fingerprint: string;
  caution: string | null;
  close: () => void;
}): ReactElement {
  const adopt = useEndpointMutation(adoptLocalDeploySecretValue, {
    meta: { suppressError: true },
    onSuccess: () => close(),
  });

  return (
    <Stack gap="md">
      <Stack gap="xs">
        <DialogTitle>Use this computer&apos;s {item.key}</DialogTitle>
        <DialogDescription>{item.description}</DialogDescription>
      </Stack>
      <Stack gap="2xs">
        <Text as="p" variant="caption" tone="muted">
          The value this computer already uses:
        </Text>
        <Text as="p" variant="code">
          {preview}
        </Text>
        {caution !== null && (
          <Text as="p" variant="caption" tone="primary">
            {caution}
          </Text>
        )}
        <Text as="p" variant="caption" tone="muted">
          It is copied into this machine&apos;s secrets store, shared by every
          deployment that needs {item.key}, and reaches a server only after you
          approve it for that deployment.
        </Text>
        {adopt.isError && (
          <Text as="p" variant="caption" tone="destructive">
            {getEndpointErrorMessage(adopt.error)}
          </Text>
        )}
      </Stack>
      <Cluster justify="end" gap="xs">
        <Button type="button" variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button
          type="button"
          onClick={() =>
            adopt.mutate({ params: { key: item.key }, body: { fingerprint } })
          }
        >
          Use this value
        </Button>
      </Cluster>
    </Stack>
  );
}
