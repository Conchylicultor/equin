import { useState, type ReactElement } from "react";
import {
  Button,
  DialogDescription,
  DialogTitle,
  Input,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  getEndpointErrorMessage,
  useEndpointMutation,
} from "@plugins/infra/plugins/endpoints/web";
import { DeploySecretValueSchema, setDeploySecretValue } from "../../core";
import type { SecretItem } from "../internal/items";

/**
 * Enter a secret's value. A password input: the value is typed or pasted,
 * never shown, and never comes back — the store is write-only from here.
 *
 * Saving does NOT approve it: the row turns `new` (or `value changed`) and
 * Approve is a second, deliberate click.
 */
export function SetValueDialog({
  item,
  close,
}: {
  item: SecretItem;
  close: () => void;
}): ReactElement {
  const [value, setValue] = useState("");
  const parsed = DeploySecretValueSchema.safeParse(value);
  const save = useEndpointMutation(setDeploySecretValue, {
    meta: { suppressError: true },
    onSuccess: () => close(),
  });

  return (
    <Stack
      as="form"
      gap="md"
      onSubmit={(e: React.FormEvent) => {
        e.preventDefault();
        if (!parsed.success) return;
        save.mutate({ params: { key: item.key }, body: { value } });
      }}
    >
      <Stack gap="xs">
        <DialogTitle>Set {item.key}</DialogTitle>
        <DialogDescription>{item.description}</DialogDescription>
      </Stack>
      <Stack gap="2xs">
        <Input
          type="password"
          autoComplete="off"
          autoFocus
          value={value}
          placeholder="Paste the value"
          onChange={(e) => setValue(e.target.value)}
        />
        <Text as="p" variant="caption" tone="muted">
          Kept in this machine's encrypted secrets store, shared by every
          deployment that needs {item.key}. It reaches a server only after you
          approve it for that deployment.
        </Text>
        {value !== "" && !parsed.success && (
          <Text as="p" variant="caption" tone="destructive">
            {parsed.error.issues[0]?.message}
          </Text>
        )}
        {save.isError && (
          <Text as="p" variant="caption" tone="destructive">
            {getEndpointErrorMessage(save.error)}
          </Text>
        )}
      </Stack>
      <Cluster justify="end" gap="xs">
        <Button type="button" variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button type="submit" disabled={!parsed.success}>
          Save value
        </Button>
      </Cluster>
    </Stack>
  );
}
