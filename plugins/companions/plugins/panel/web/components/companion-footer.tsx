import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { Inset } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { useBrowserValue } from "@plugins/primitives/plugins/dom/plugins/render-mode/web";

const readOrigin = (): string => window.location.origin;
const readHostname = (): string => window.location.hostname;

/**
 * A companion's last row: equin is running here (the page is served, so the
 * gateway is up — only a native host can report it down, from outside), on
 * this host. The whole row opens equin: through the host's `open` (the
 * menu-bar helper's default browser, the extension's new tab) when it has
 * one, else as a plain link to a new tab.
 */
export function CompanionFooter({
  open,
}: {
  /** How the host opens a URL; `null`: it has no way, so the row is a link. */
  open: ((url: string) => void) | null;
}) {
  const origin = useBrowserValue({ name: "location.origin", read: readOrigin });
  const hostname = useBrowserValue({
    name: "location.hostname",
    read: readHostname,
  });
  const home = `${origin}/`;
  const label = (
    <Text variant="caption" tone="muted">
      Running · {hostname}
    </Text>
  );
  const dot = <StatusDot colorClass="bg-success" />;
  return (
    <Inset y="xs">
      {open !== null ? (
        <Row
          icon={dot}
          title="Open equin"
          className="gap-md"
          onClick={() => open(home)}
        >
          {label}
        </Row>
      ) : (
        <Row
          icon={dot}
          title="Open equin"
          className="gap-md"
          href={home}
          target="_blank"
          rel="noreferrer"
        >
          {label}
        </Row>
      )}
    </Inset>
  );
}
