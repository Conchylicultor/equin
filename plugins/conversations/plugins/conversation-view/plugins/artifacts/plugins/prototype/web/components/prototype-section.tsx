import { matchResource } from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { prototypesList } from "@plugins/apps/plugins/prototypes/plugins/files/core";
import { prototypeDetailPane } from "@plugins/apps/plugins/prototypes/plugins/canvas/web";
import type { ArtifactItem } from "@plugins/conversations/plugins/conversation-view/plugins/artifacts/core";
import { ArtifactRow } from "@plugins/conversations/plugins/conversation-view/plugins/artifacts/web";
import { NewTabButton } from "@plugins/primitives/plugins/link-gesture/plugins/new-tab/web";
import {
  prototypeDetailRoute,
  prototypesApp,
} from "@plugins/apps/plugins/prototypes/plugins/shell/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const dashboardCustomizeIcon = symbol("dashboard-customize");

/**
 * The glyph, in one place: the registry draws it on the contribution and every
 * row draws it again, and a row whose icon disagreed with its own section's
 * would read as a different kind of thing.
 *
 * It is the Prototypes app's own icon, not the mock's monitor: a row here opens
 * that app, and the thing you land in should wear the mark you clicked.
 */
export const PROTOTYPE_ICON = dashboardCustomizeIcon;

/**
 * Why a row cannot be opened. A prototype id is opaque and permanent, so an id
 * the list does not carry is not a stale label — the folder is gone, or was
 * never on this machine. Either way there is nothing to open, and the row says
 * so rather than opening an empty pane.
 */
const NO_SUCH_PROTOTYPE = "No such prototype — deleted, or never created here";

/**
 * The prototypes a conversation touched, one per line.
 *
 * Resolution is free: `prototypesList` is a live, app-wide list
 * re-broadcast on every file change under the prototypes dir, so a popover full
 * of ids costs no requests and the titles track a rename of the `<title>` live.
 *
 * Until it arrives the rows are skeletons, one per artifact. The *count* is
 * known from the transcript alone — that is what the button shows — but a
 * *title* is not, and `proto-1786877040-w2vi` standing in for one would read as
 * the answer rather than as the wait for it.
 */
export function PrototypeSection({ items }: { items: ArtifactItem[] }) {
  const prototypes = useLive(prototypesList);
  const openPane = useOpenPane();

  return matchResource(prototypes, {
    loading: () => <Loading variant="rows" count={items.length} />,
    ready: (metas) => (
      <Stack gap="none">
        {items.map((item) => {
          const meta = metas.find((p) => p.name === item.key);
          return (
            <ArtifactRow
              key={item.key}
              item={item}
              icon={PROTOTYPE_ICON}
              title={meta?.title ?? item.key}
              inertReason={meta === undefined ? NO_SUCH_PROTOTYPE : undefined}
              actions={
                meta === undefined ? undefined : (
                  // The prototype alone, in its own app — not the conversation
                  // with the mock beside it, which is what the row's ⌘-click
                  // URL carries.
                  <NewTabButton
                    href={prototypeDetailRoute.link(prototypesApp, {
                      name: item.key,
                    })}
                  />
                )
              }
              activation={
                meta === undefined
                  ? undefined
                  : // `push` opens the mock as a column to the RIGHT of the
                    // conversation, so the transcript stays beside it.
                    openPane.to(
                      prototypeDetailPane,
                      { name: item.key },
                      { mode: "push" },
                    )
              }
            />
          );
        })}
      </Stack>
    ),
  });
}
