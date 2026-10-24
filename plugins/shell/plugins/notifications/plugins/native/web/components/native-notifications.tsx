import { useConfig, useSetConfig } from "@plugins/config_v2/web";
import { useNativeHost } from "@plugins/menu-bar/web";
import { useNotificationArrivals } from "@plugins/shell/plugins/notifications/web";
import { Separator } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { SwitchIndicator } from "@plugins/primitives/plugins/css/plugins/switch/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { nativeNotificationsConfig } from "../../shared/config";

const onIcon = symbol("notifications-active");
const offIcon = symbol("notifications-off");

/**
 * The panel's Notifications switch — only where the helper can notify (a host
 * without the capability shows nothing: there is nothing to switch on).
 */
export function NativeNotificationsSwitch() {
  const host = useNativeHost();
  const { enabled } = useConfig(nativeNotificationsConfig);
  const setConfig = useSetConfig(nativeNotificationsConfig);
  if (host.kind !== "present" || host.notify === null) return null;
  return (
    <Stack gap="sm">
      {/* Its own rule: where the helper cannot notify the section is absent,
          and so is the rule. */}
      <Inset x="md">
        <Separator />
      </Inset>
      <Row
        role="switch"
        aria-checked={enabled}
        className="gap-md"
        icon={
          <Icon
            icon={enabled ? onIcon : offIcon}
            className="text-muted-foreground"
          />
        }
        onClick={() => setConfig("enabled", !enabled)}
      >
        <Fill>
          <Text>Notifications</Text>
        </Fill>
        <SwitchIndicator checked={enabled} />
      </Row>
    </Stack>
  );
}

/**
 * While the switch is on, hands each notification that arrives to the OS
 * (pushed live; the ones already there are never re-announced). Mounted for as
 * long as the panel page lives — the helper keeps it loaded while hidden.
 */
export function NativeNotificationsForwarder(): null {
  const host = useNativeHost();
  const { enabled } = useConfig(nativeNotificationsConfig);
  const notify = host.kind === "present" ? host.notify : null;
  useNotificationArrivals((n) => {
    if (!enabled || notify === null) return;
    void notify({ title: n.title, body: n.description, tag: n.id });
  });
  return null;
}
