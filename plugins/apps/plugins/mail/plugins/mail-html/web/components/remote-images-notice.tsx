import type { ReactElement } from "react";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useMachineAvailability } from "@plugins/infra/plugins/endpoints/web";
import { getMailImage } from "@plugins/apps/plugins/mail/plugins/remote-images/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const imageIcon = symbol("image");

/**
 * The notice above a body whose remote images `<MailHtml>` blocked: "Display
 * images" opts in (`onDisplay`) where the image proxy can answer. Where it
 * cannot (a host without the computer — `getMailImage` is `needsMachine`), the
 * notice says so instead of offering a button whose images would all be
 * stripped, so availability is decided where the choice is drawn.
 */
export function RemoteImagesNotice({
  onDisplay,
}: {
  onDisplay: () => void;
}): ReactElement {
  const proxy = useMachineAvailability(getMailImage);
  return (
    <Row
      bordered
      icon={<Icon icon={imageIcon} className="icon-auto" />}
      actionsAlwaysVisible
      actions={
        proxy.available ? (
          <Button variant="outline" onClick={onDisplay}>
            Display images
          </Button>
        ) : undefined
      }
    >
      <Text variant="caption" tone="muted">
        {proxy.available
          ? "Images are hidden to protect your privacy."
          : `Images are hidden. ${proxy.message}`}
      </Text>
    </Row>
  );
}
