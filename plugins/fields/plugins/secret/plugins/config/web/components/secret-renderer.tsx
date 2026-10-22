import {
  ConfigFieldContext,
  defineFieldShape,
  useLocalValue,
} from "@plugins/config_v2/plugins/fields/web";
import { secretFieldType } from "@plugins/fields/plugins/secret/core";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  Button,
  ControlSizeProvider,
  Input,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { useContext, useState } from "react";
import { configSecretMeta } from "../../core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const checkIcon = symbol("check");

/**
 * The one field type whose CONTROL has two states — and now that is all it has:
 * both states land in the same value cell of the same row, so "Configured" and
 * "enter a secret" can no longer be two differently-shaped blocks.
 *
 * `fit` is `"field"` in every state on purpose. It is the panel's value track,
 * so a row that switched between `field` and `inline` would resize as the user
 * used it.
 */
const SecretRenderer = defineFieldShape({
  type: secretFieldType,
  useShape: ({ field, value, onChange }) => {
    const ctx = useContext(ConfigFieldContext);
    const [editing, setEditing] = useState(false);
    const { local, setLocal, focus } = useLocalValue(value);

    // Outside a config field (an event source's config form renders field
    // shapes with no ConfigFieldContext) there is no stored config secret to
    // describe: nothing is read, and the field is a plain secret input.
    const metaResult = useLive(
      configSecretMeta,
      ctx ? { path: ctx.storePath } : null,
    );

    let isSet = false;
    if (ctx !== null) {
      // Not-known-yet is a state to render, never a value to stand in for: a
      // loading read reported as `isSet: false` would show the password input
      // for a secret that IS configured, then swap under the user.
      if (metaResult.status === "loading") {
        return {
          kind: "value",
          fit: "field",
          control: <Loading variant="text" />,
        };
      }
      if (metaResult.status === "error") {
        return {
          kind: "value",
          fit: "field",
          control: (
            <ResourceErrorInline
              variant="inline"
              subject="whether this secret is set"
              error={metaResult.error}
              refetch={metaResult.refetch}
            />
          ),
        };
      }
      // A host without the computer (the demo's browser worker) holds no
      // secrets store: say so instead of offering an input it cannot keep.
      if (metaResult.status === "unavailable") {
        return {
          kind: "value",
          fit: "field",
          control: (
            <Text variant="caption" tone="muted">
              {metaResult.message}
            </Text>
          ),
        };
      }
      isSet = metaResult.data[ctx.fieldKey]?.set ?? false;
    }
    if (isSet && !editing) {
      return {
        kind: "value",
        fit: "field",
        control: (
          <Stack direction="row" align="center" gap="sm">
            <Stack
              direction="row"
              align="center"
              gap="xs"
              className="text-success"
            >
              <Icon icon={checkIcon} className="size-3.5" />
              <Text variant="caption">Configured</Text>
            </Stack>
            <ControlSizeProvider size="xs">
              <Button
                variant="ghost"
                className="px-sm"
                onClick={() => setEditing(true)}
              >
                Replace
              </Button>
            </ControlSizeProvider>
          </Stack>
        ),
      };
    }

    return {
      kind: "value",
      fit: "field",
      control: (
        <Input
          type="password"
          value={local}
          placeholder={field.meta.placeholder ?? "Enter secret…"}
          onFocus={focus.onFocus}
          onBlur={() => {
            focus.onBlur();
            if (local !== value) {
              onChange(local);
              setLocal("");
              setEditing(false);
            } else if (editing) {
              setEditing(false);
            }
          }}
          onChange={(e) => setLocal(e.target.value)}
        />
      ),
    };
  },
});

export { SecretRenderer };
