import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { useNativeHost } from "../native-host";

/**
 * The panel's last row: equin is running here (the page is served, so the
 * gateway is up — only the helper can report it down, from outside), on this
 * host. The whole row opens equin: in the default browser through the helper,
 * or as a plain link when the page is not inside one.
 */
export function PanelFooter() {
  const host = useNativeHost();
  if (host.kind === "pending")
    return <Loading variant="block" className="h-6 w-full" />;
  const { origin, host: hostname } = window.location;
  const home = `${origin}/`;
  const openUrl = host.kind === "present" ? host.openUrl : null;
  const label = (
    <Text variant="caption" tone="muted">
      Running · {hostname}
    </Text>
  );
  const dot = <StatusDot colorClass="bg-success" />;
  return openUrl !== null ? (
    <Row icon={dot} title="Open equin" onClick={() => void openUrl(home)}>
      {label}
    </Row>
  ) : (
    <Row
      icon={dot}
      title="Open equin"
      href={home}
      target="_blank"
      rel="noreferrer"
    >
      {label}
    </Row>
  );
}
