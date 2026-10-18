import type { ReactElement, ReactNode } from "react";
import { matchResource } from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  prototypeHistory,
  type PrototypeVersion,
  type PrototypeViewport,
  type StoredPicks,
} from "@plugins/apps/plugins/prototypes/plugins/files/core";
import { PrototypeDetailProvider } from "@plugins/apps/plugins/prototypes/plugins/canvas/web";
import { prototypePresentPane } from "../panes";
import {
  LIVE_VERSION,
  decodePicks,
  decodeSize,
} from "../internal/present-link";
import { PresentBox } from "./present-box";
import { PresentStage } from "./present-stage";

/**
 * One frame presented as a page of its own (a chromeless new browser tab): the
 * frame filling the page, its chrome on hover. No Exit — the
 * tab itself is the presentation, and closing it is how you leave.
 *
 * It mounts a one-frame canvas: the URL's version (looked up in the history,
 * so the options pill offers the options THAT version declares) and, when the
 * URL carries them, the frame's own picks — else the shared record, as frame A;
 * and the URL's size, else the one the prototype declares.
 */
export function PresentPage(): ReactElement {
  const { name, version, size, picks } = prototypePresentPane.useParams();
  const own = picks === undefined ? undefined : decodePicks(picks);
  const at = decodeSize(size);
  return version === LIVE_VERSION ? (
    <PresentPageBody name={name} version={null} picks={own} size={at} />
  ) : (
    <VersionPresentPage name={name} sha={version} picks={own} size={at} />
  );
}

function VersionPresentPage({
  name,
  sha,
  picks,
  size,
}: {
  name: string;
  sha: string;
  picks: StoredPicks | undefined;
  size: PrototypeViewport | undefined;
}): ReactNode {
  const history = useLive(prototypeHistory, { name });
  return matchResource(history, {
    loading: () => <Loading variant="block" />,
    ready: (h) => {
      const version = h.versions.find((v) => v.sha === sha);
      return version ? (
        <PresentPageBody
          name={name}
          version={version}
          picks={picks}
          size={size}
        />
      ) : (
        <Text as="div" variant="body" tone="muted" className="p-lg">
          This version is no longer in the prototype&apos;s history.
        </Text>
      );
    },
  });
}

function PresentPageBody({
  name,
  version,
  picks,
  size,
}: {
  name: string;
  version: PrototypeVersion | null;
  picks: StoredPicks | undefined;
  size: PrototypeViewport | undefined;
}): ReactElement {
  return (
    <PrototypeDetailProvider
      name={name}
      initialVersion={version}
      {...(picks === undefined ? {} : { initialPicks: picks })}
      {...(size === undefined ? {} : { initialSize: size })}
    >
      <PresentBox>
        <PresentStage name={name} />
      </PresentBox>
    </PrototypeDetailProvider>
  );
}
